alter table public.imposter_rooms
    add column if not exists game_mode text not null default 'challenge'
        check (game_mode in ('challenge', 'speed')),
    add column if not exists speed_unit text not null default 'kph'
        check (speed_unit in ('kph', 'mph')),
    add column if not exists min_speed integer not null default 0
        check (min_speed between 0 and 500),
    add column if not exists max_speed integer not null default 130
        check (max_speed between 1 and 500),
    add column if not exists imposter_hint boolean not null default true,
    add column if not exists hide_imposter_role boolean not null default false,
    add column if not exists chat_enabled boolean not null default true,
    add column if not exists settings_locked boolean not null default false,
    add column if not exists round_number integer not null default 1
        check (round_number > 0);

alter table public.imposter_player_sessions
    add column if not exists speed_target integer,
    add column if not exists speed_hint_min integer,
    add column if not exists speed_hint_max integer;

create table if not exists public.imposter_messages (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.imposter_rooms(id) on delete cascade,
    round_number integer not null,
    sender_id uuid not null references public.imposter_players(id) on delete cascade,
    content text not null check (char_length(content) between 1 and 500),
    created_at timestamptz not null default now()
);

create index if not exists imposter_messages_round_idx
    on public.imposter_messages(room_id, round_number, created_at);

alter table public.imposter_messages enable row level security;
revoke all on public.imposter_messages from anon, authenticated;

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

    if (select count(*) from public.imposter_players where room_id = v_room.id) >= 2
       and not exists (
           select 1 from public.imposter_players
           where room_id = v_room.id and not ready
       ) then
        select array_agg(id order by random()) into v_player_ids
        from public.imposter_players where room_id = v_room.id;
        v_imposters := v_player_ids[1:v_room.imposter_count];
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
        set phase = 'playing',
            settings_locked = true,
            results = null,
            updated_at = now()
        where id = v_room.id;
    end if;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

drop function if exists public.imposter_update_settings(text, integer, text, text[]);
drop function if exists public.imposter_update_settings(
    text, integer, text, text[], text, text, integer, integer, boolean, boolean, boolean
);

create function public.imposter_update_settings(
    p_token text,
    p_imposter_count integer,
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
        'own_goal', 'three_demos', 'bump_teammates',
        'lose_kickoffs', 'no_goals', 'stay_in_half'
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
    if p_imposter_count is null or p_imposter_count < 1
       or p_imposter_count > v_player_count then
        raise exception 'Imposter count must be between 1 and the player count.';
    end if;
    select array_agg(value order by value) into v_enabled
    from unnest(p_enabled_challenges) as value;

    update public.imposter_rooms
    set imposter_count = p_imposter_count,
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

create or replace function public.imposter_send_message(p_token text, p_content text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
    v_content text;
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
    if not v_room.chat_enabled or v_room.phase not in ('playing', 'voting') then
        raise exception 'Round chat is not available right now.';
    end if;
    v_content := btrim(coalesce(p_content, ''));
    if char_length(v_content) not between 1 and 500 then
        raise exception 'Chat messages must be between 1 and 500 characters.';
    end if;
    insert into public.imposter_messages (room_id, round_number, sender_id, content)
    values (v_room.id, v_room.round_number, v_player.player_id, v_content);
    update public.imposter_rooms set updated_at = now() where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_end_voting(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
    v_tally jsonb;
    v_roles jsonb;
    v_speeds jsonb;
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
    if v_room.host_player_id <> v_player.player_id or v_room.phase <> 'voting' then
        raise exception 'Only the host can end voting.';
    end if;
    select coalesce(jsonb_object_agg(p.id::text, coalesce(t.vote_count, 0)), '{}'::jsonb)
    into v_tally
    from public.imposter_players p
    left join (
        select suspects.suspect_id, count(*)::integer as vote_count
        from public.imposter_votes v
        cross join lateral unnest(v.suspects) as suspects(suspect_id)
        where v.room_id = v_room.id
        group by suspects.suspect_id
    ) t on t.suspect_id = p.id
    where p.room_id = v_room.id;
    select coalesce(jsonb_object_agg(p.id::text, s.role), '{}'::jsonb)
    into v_roles
    from public.imposter_players p
    join public.imposter_player_sessions s on s.player_id = p.id
    where p.room_id = v_room.id;
    select coalesce(
        jsonb_object_agg(p.id::text, s.speed_target)
            filter (where s.speed_target is not null),
        '{}'::jsonb
    )
    into v_speeds
    from public.imposter_players p
    join public.imposter_player_sessions s on s.player_id = p.id
    where p.room_id = v_room.id;

    update public.imposter_rooms
    set phase = 'results',
        results = jsonb_build_object(
            'tally', v_tally,
            'roles', v_roles,
            'speedTargets', v_speeds,
            'sharedSpeedTarget', (
                select min(s.speed_target)
                from public.imposter_players p
                join public.imposter_player_sessions s on s.player_id = p.id
                where p.room_id = v_room.id and s.role = 'safe'
            ),
            'submittedVotes', (
                select count(*) from public.imposter_votes where room_id = v_room.id
            )
        ),
        updated_at = now()
    where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_next_round(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
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
    if v_room.host_player_id <> v_player.player_id or v_room.phase <> 'results' then
        raise exception 'Only the host can start the next round.';
    end if;
    delete from public.imposter_votes where room_id = v_room.id;
    delete from public.imposter_messages where room_id = v_room.id;
    update public.imposter_player_sessions
    set role = null,
        challenge = null,
        challenge_complete = false,
        speed_target = null,
        speed_hint_min = null,
        speed_hint_max = null
    where player_id in (
        select id from public.imposter_players where room_id = v_room.id
    );
    update public.imposter_players set ready = false where room_id = v_room.id;
    update public.imposter_rooms
    set phase = 'lobby',
        round_number = round_number + 1,
        results = null,
        updated_at = now()
    where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

revoke all on function public.imposter_get_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.imposter_set_ready(text, boolean) from public, anon, authenticated;
revoke all on function public.imposter_update_settings(
    text, integer, text, text[], text, text, integer, integer, boolean, boolean, boolean
) from public, anon, authenticated;
revoke all on function public.imposter_send_message(text, text) from public, anon, authenticated;
revoke all on function public.imposter_end_voting(text) from public, anon, authenticated;
revoke all on function public.imposter_next_round(text) from public, anon, authenticated;

grant execute on function public.imposter_update_settings(
    text, integer, text, text[], text, text, integer, integer, boolean, boolean, boolean
) to anon, authenticated;
grant execute on function public.imposter_send_message(text, text) to anon, authenticated;
grant execute on function public.imposter_set_ready(text, boolean) to anon, authenticated;
grant execute on function public.imposter_end_voting(text) to anon, authenticated;
grant execute on function public.imposter_next_round(text) to anon, authenticated;
