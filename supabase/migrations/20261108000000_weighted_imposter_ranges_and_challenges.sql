alter table public.imposter_rooms
    add column if not exists imposter_min_count integer not null default 1
        check (imposter_min_count between 1 and 12),
    add column if not exists imposter_max_count integer not null default 1
        check (imposter_max_count between 1 and 12),
    add column if not exists random_imposter_count boolean not null default false;

update public.imposter_rooms
set imposter_min_count = imposter_count,
    imposter_max_count = imposter_count;

alter table public.imposter_rooms
    alter column enabled_challenges set default array[
        'own_goal', 'three_demos', 'bump_teammates', 'lose_kickoffs',
        'no_goals', 'stay_in_half', 'touch_ceiling', 'three_assists',
        'steal_boost', 'three_clears', 'two_turtle_plays', 'flip_reset_teammate',
        'rule_one', 'three_whiffs', 'same_big_boost', 'reverse_only',
        'stay_above_50_boost', 'hit_post_twice', 'three_pinches', 'wall_lap',
        'goal_celebration', 'kickoff_strategy', 'least_score', 'off_ballcam',
        'upside_down_controller', 'least_ball_touches', 'most_boost', 'most_bumps',
        'shots_no_goals', 'no_teammate_touch', 'overtime', 'lose_match',
        'no_consecutive_touches', 'last_kickoff_touch', 'airborne_ten_seconds',
        'insane_lie', 'five_compliments', 'fake_lag', 'accused_and_cleared',
        'opponent_reply', 'afk_twenty_seconds', 'demoed_three_times',
        'first_touch_goal', 'zero_boost_goal', 'no_jump_thirty_seconds'
    ]::text[];

create or replace function public.imposter_get_state(p_room_id uuid, p_player_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'playerId', p_player_id,
        'role', case
            when r.phase not in ('playing', 'voting', 'results') then null
            when r.phase <> 'results'
                and r.game_mode = 'speed'
                and r.hide_imposter_role
                and own_session.role = 'imposter' then 'safe'
            else own_session.role
        end,
        'roleHidden', coalesce(
            r.phase in ('playing', 'voting')
            and r.game_mode = 'speed'
            and r.hide_imposter_role
            and own_session.role = 'imposter',
            false
        ),
        'challenge', case
            when r.phase in ('playing', 'voting', 'results') then own_session.challenge
            else null
        end,
        'speedTarget', case
            when r.phase in ('playing', 'voting', 'results') then own_session.speed_target
            else null
        end,
        'speedHint', case
            when own_session.speed_hint_min is not null then jsonb_build_object(
                'min', own_session.speed_hint_min,
                'max', own_session.speed_hint_max
            )
            else null
        end,
        'results', case when r.phase = 'results' then r.results else null end,
        'room', jsonb_build_object(
            'id', r.id,
            'code', r.code,
            'phase', r.phase,
            'roundNumber', r.round_number,
            'settingsLocked', r.settings_locked,
            'settings', jsonb_build_object(
                'imposterCount', r.imposter_count,
                'imposterMinCount', r.imposter_min_count,
                'imposterMaxCount', r.imposter_max_count,
                'randomImposterCount', r.random_imposter_count,
                'challengeAssignment', r.challenge_assignment,
                'enabledChallenges', r.enabled_challenges,
                'gameMode', r.game_mode,
                'speedUnit', r.speed_unit,
                'minSpeed', r.min_speed,
                'maxSpeed', r.max_speed,
                'imposterHint', r.imposter_hint,
                'hideImposterRole', r.hide_imposter_role,
                'chatEnabled', r.chat_enabled
            ),
            'players', coalesce((
                select jsonb_agg(jsonb_build_object(
                    'id', p.id,
                    'name', p.name,
                    'isHost', r.host_player_id = p.id,
                    'ready', p.ready,
                    'voted', exists (
                        select 1 from public.imposter_votes v
                        where v.room_id = r.id and v.voter_id = p.id
                    ),
                    'challengeComplete', case
                        when r.phase = 'results' or p.id = p_player_id then s.challenge_complete
                        else null
                    end
                ) order by p.created_at, p.id)
                from public.imposter_players p
                join public.imposter_player_sessions s on s.player_id = p.id
                where p.room_id = r.id
            ), '[]'::jsonb),
            'messages', case
                when r.chat_enabled and r.phase in ('playing', 'voting') then coalesce((
                    select jsonb_agg(jsonb_build_object(
                        'id', m.id,
                        'roleLabel', case
                            when r.game_mode = 'speed'
                                and r.hide_imposter_role
                                and r.phase <> 'results' then 'Player'
                            when sender.role = 'imposter' then 'Imposter'
                            else 'Safe'
                        end,
                        'content', m.content,
                        'createdAt', m.created_at
                    ) order by m.created_at, m.id)
                    from public.imposter_messages m
                    join public.imposter_player_sessions sender
                        on sender.player_id = m.sender_id
                    where m.room_id = r.id
                      and m.round_number = r.round_number
                ), '[]'::jsonb)
                else '[]'::jsonb
            end
        )
    )
    from public.imposter_rooms r
    left join public.imposter_player_sessions own_session
        on own_session.player_id = p_player_id
    where r.id = p_room_id
      and exists (
          select 1 from public.imposter_players p
          where p.id = p_player_id and p.room_id = r.id
      );
$$;

create or replace function public.imposter_set_ready(p_token text, p_ready boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
    v_player_ids uuid[];
    v_imposters uuid[];
    v_shared_challenge text;
    v_shared_speed integer;
    v_player_id uuid;
    v_player_role text;
    v_assigned_speed integer;
    v_hint_width integer;
    v_hint_low integer;
    v_hint_start_min integer;
    v_hint_start_max integer;
    v_imposter_count integer;
    v_imposter_max integer;
    v_selection_roll double precision;
    v_candidate integer;
begin
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    select * into v_room from public.imposter_rooms
    where id = v_player.room_id for update;
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    if v_room.phase <> 'lobby' then
        raise exception 'This round cannot be readied up.';
    end if;
    if p_ready is distinct from true then
        raise exception 'Players cannot unready once they are ready.';
    end if;
    if exists (
        select 1 from public.imposter_players
        where id = v_player.player_id and ready
    ) then
        raise exception 'You are already ready.';
    end if;

    update public.imposter_players set ready = true where id = v_player.player_id;
    update public.imposter_rooms
    set updated_at = now()
    where id = v_room.id;

    select count(*) into v_imposter_max
    from public.imposter_players where room_id = v_room.id;
    if v_imposter_max >= 2
       and not exists (
           select 1 from public.imposter_players
           where room_id = v_room.id and not ready
       ) then
        v_imposter_max := least(v_room.imposter_max_count, v_imposter_max - 1);
        v_imposter_count := least(v_room.imposter_min_count, v_imposter_max);
        if v_room.random_imposter_count and v_room.imposter_min_count < v_imposter_max then
            v_selection_roll := random() * (
                2.0::double precision
                    - power(0.5::double precision, v_imposter_max - v_room.imposter_min_count + 1)
            );
            for v_candidate in v_room.imposter_min_count..v_imposter_max loop
                v_selection_roll := v_selection_roll
                    - power(0.5::double precision, v_candidate - v_room.imposter_min_count);
                if v_selection_roll < 0 then
                    v_imposter_count := v_candidate;
                    exit;
                end if;
            end loop;
        elsif not v_room.random_imposter_count then
            v_imposter_count := v_imposter_max;
        end if;

        select array_agg(id order by random()) into v_player_ids
        from public.imposter_players where room_id = v_room.id;
        v_imposters := v_player_ids[1:v_imposter_count];
        v_shared_challenge := v_room.enabled_challenges[
            1 + floor(random() * cardinality(v_room.enabled_challenges))::integer
        ];
        if v_room.game_mode = 'speed' then
            v_shared_speed := v_room.min_speed
                + floor(random() * (v_room.max_speed - v_room.min_speed + 1))::integer;
        end if;

        foreach v_player_id in array v_player_ids loop
            v_player_role := case
                when v_player_id = any(v_imposters) then 'imposter'
                else 'safe'
            end;
            v_assigned_speed := null;
            v_hint_low := null;
            v_hint_width := null;

            if v_room.game_mode = 'speed' then
                if v_player_role = 'safe' then
                    v_assigned_speed := v_shared_speed;
                elsif v_room.hide_imposter_role then
                    v_assigned_speed := v_room.min_speed
                        + floor(random() * (v_room.max_speed - v_room.min_speed))::integer;
                    if v_assigned_speed >= v_shared_speed then
                        v_assigned_speed := v_assigned_speed + 1;
                    end if;
                end if;

                if v_player_role = 'imposter'
                   and v_room.imposter_hint
                   and not v_room.hide_imposter_role then
                    v_hint_width := greatest(
                        2,
                        floor((v_room.max_speed - v_room.min_speed) * 0.45)::integer
                    );
                    v_hint_width := least(v_hint_width, v_room.max_speed - v_room.min_speed);
                    v_hint_start_min := greatest(
                        v_room.min_speed,
                        v_shared_speed - v_hint_width
                    );
                    v_hint_start_max := least(
                        v_shared_speed,
                        v_room.max_speed - v_hint_width
                    );
                    v_hint_low := v_hint_start_min
                        + floor(random() * (v_hint_start_max - v_hint_start_min + 1))::integer;
                    if v_hint_width % 2 = 0
                       and v_hint_low + v_hint_width / 2 = v_shared_speed then
                        if v_hint_low < v_hint_start_max then
                            v_hint_low := v_hint_low + 1;
                        elsif v_hint_low > v_hint_start_min then
                            v_hint_low := v_hint_low - 1;
                        end if;
                    end if;
                end if;
            end if;

            update public.imposter_player_sessions
            set role = v_player_role,
                challenge = case
                    when v_room.game_mode <> 'challenge' or v_player_role <> 'imposter' then null
                    when v_room.challenge_assignment = 'same' then v_shared_challenge
                    else v_room.enabled_challenges[
                        1 + floor(random() * cardinality(v_room.enabled_challenges))::integer
                    ]
                end,
                challenge_complete = false,
                speed_target = v_assigned_speed,
                speed_hint_min = case when v_hint_low is null then null else v_hint_low end,
                speed_hint_max = case
                    when v_hint_low is null then null
                    else v_hint_low + v_hint_width
                end
            where player_id = v_player_id;
        end loop;

        update public.imposter_rooms
        set imposter_count = v_imposter_count,
            phase = 'playing',
            settings_locked = true,
            results = null,
            updated_at = now()
        where id = v_room.id;
    end if;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

drop function if exists public.imposter_update_settings(
    text, integer, text, text[], text, text, integer, integer, boolean, boolean, boolean
);
drop function if exists public.imposter_update_settings(text, integer, text, text[]);

create function public.imposter_update_settings(
    p_token text,
    p_imposter_min_count integer,
    p_imposter_max_count integer,
    p_random_imposter_count boolean,
    p_challenge_assignment text,
    p_enabled_challenges text[],
    p_game_mode text,
    p_speed_unit text,
    p_min_speed integer,
    p_max_speed integer,
    p_imposter_hint boolean,
    p_hide_imposter_role boolean,
    p_chat_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
    v_enabled text[];
    v_allowed constant text[] := array[
        'own_goal', 'three_demos', 'bump_teammates', 'lose_kickoffs',
        'no_goals', 'stay_in_half', 'touch_ceiling', 'three_assists',
        'steal_boost', 'three_clears', 'two_turtle_plays', 'flip_reset_teammate',
        'rule_one', 'three_whiffs', 'same_big_boost', 'reverse_only',
        'stay_above_50_boost', 'hit_post_twice', 'three_pinches', 'wall_lap',
        'goal_celebration', 'kickoff_strategy', 'least_score', 'off_ballcam',
        'upside_down_controller', 'least_ball_touches', 'most_boost', 'most_bumps',
        'shots_no_goals', 'no_teammate_touch', 'overtime', 'lose_match',
        'no_consecutive_touches', 'last_kickoff_touch', 'airborne_ten_seconds',
        'insane_lie', 'five_compliments', 'fake_lag', 'accused_and_cleared',
        'opponent_reply', 'afk_twenty_seconds', 'demoed_three_times',
        'first_touch_goal', 'zero_boost_goal', 'no_jump_thirty_seconds'
    ];
    v_player_count integer;
begin
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    select * into v_room from public.imposter_rooms
    where id = v_player.room_id for update;
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    if v_room.host_player_id <> v_player.player_id
       or v_room.phase <> 'lobby'
       or v_room.settings_locked then
        raise exception 'Settings are locked after the first round starts.';
    end if;
    if p_game_mode not in ('challenge', 'speed') then
        raise exception 'Choose a valid game mode.';
    end if;
    if p_speed_unit not in ('kph', 'mph') then
        raise exception 'Choose kph or mph.';
    end if;
    if p_min_speed is null or p_max_speed is null
       or p_min_speed < 0 or p_max_speed > 500
       or p_max_speed <= p_min_speed then
        raise exception 'Minimum speed must be lower than maximum speed; use values from 0 to 500.';
    end if;
    if p_enabled_challenges is null or cardinality(p_enabled_challenges) = 0
       or not (p_enabled_challenges <@ v_allowed)
       or cardinality(p_enabled_challenges) <> (
           select count(distinct value) from unnest(p_enabled_challenges) as value
       ) then
        raise exception 'Enable at least one valid challenge.';
    end if;
    if p_challenge_assignment not in ('same', 'random') then
        raise exception 'Choose same or random challenge assignment.';
    end if;
    select count(*) into v_player_count
    from public.imposter_players where room_id = v_room.id;
    if p_imposter_min_count is null or p_imposter_max_count is null
       or p_imposter_min_count < 1
       or p_imposter_max_count < p_imposter_min_count
       or p_imposter_max_count > greatest(1, v_player_count - 1)
       or (not coalesce(p_random_imposter_count, false)
           and p_imposter_min_count <> p_imposter_max_count) then
        raise exception 'Choose an imposter count range that leaves at least one safe player.';
    end if;
    select array_agg(value order by value) into v_enabled
    from unnest(p_enabled_challenges) as value;

    update public.imposter_rooms
    set imposter_count = p_imposter_max_count,
        imposter_min_count = p_imposter_min_count,
        imposter_max_count = p_imposter_max_count,
        random_imposter_count = coalesce(p_random_imposter_count, false),
        challenge_assignment = p_challenge_assignment,
        enabled_challenges = v_enabled,
        game_mode = p_game_mode,
        speed_unit = p_speed_unit,
        min_speed = p_min_speed,
        max_speed = p_max_speed,
        imposter_hint = coalesce(p_imposter_hint, false)
            and not coalesce(p_hide_imposter_role, false),
        hide_imposter_role = coalesce(p_hide_imposter_role, false),
        chat_enabled = coalesce(p_chat_enabled, false),
        updated_at = now()
    where id = v_room.id;
    update public.imposter_players set ready = false where room_id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_leave(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
    v_next_host uuid;
    v_max_safe_count integer;
begin
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    perform 1 from public.imposter_rooms where id = v_player.room_id for update;
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;

    delete from public.imposter_votes
    where room_id = v_player.room_id and voter_id = v_player.player_id;
    update public.imposter_votes
    set suspects = array_remove(suspects, v_player.player_id)
    where room_id = v_player.room_id and v_player.player_id = any(suspects);
    delete from public.imposter_players where id = v_player.player_id;

    select id into v_next_host
    from public.imposter_players
    where room_id = v_player.room_id
    order by created_at, id
    limit 1;
    if v_next_host is null then
        delete from public.imposter_rooms where id = v_player.room_id;
    else
        select greatest(1, count(*)::integer - 1) into v_max_safe_count
        from public.imposter_players where room_id = v_player.room_id;
        update public.imposter_rooms
        set host_player_id = v_next_host,
            imposter_count = least(imposter_count, v_max_safe_count),
            imposter_min_count = least(imposter_min_count, v_max_safe_count),
            imposter_max_count = least(imposter_max_count, v_max_safe_count),
            random_imposter_count = random_imposter_count
                and imposter_min_count < least(imposter_max_count, v_max_safe_count),
            updated_at = now()
        where id = v_player.room_id;
    end if;
    return jsonb_build_object('left', true);
end;
$$;

revoke all on function public.imposter_get_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.imposter_set_ready(text, boolean) from public, anon, authenticated;
revoke all on function public.imposter_update_settings(
    text, integer, integer, boolean, text, text[], text, text, integer, integer, boolean, boolean, boolean
) from public, anon, authenticated;

grant execute on function public.imposter_update_settings(
    text, integer, integer, boolean, text, text[], text, text, integer, integer, boolean, boolean, boolean
) to anon, authenticated;
grant execute on function public.imposter_set_ready(text, boolean) to anon, authenticated;
