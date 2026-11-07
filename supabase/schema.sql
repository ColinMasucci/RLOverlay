create extension if not exists pgcrypto with schema extensions;

create table if not exists public.imposter_rooms (
    id uuid primary key default gen_random_uuid(),
    code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
    host_player_id uuid,
    phase text not null default 'lobby'
        check (phase in ('lobby', 'playing', 'voting', 'results')),
    imposter_count integer not null default 1 check (imposter_count between 1 and 12),
    challenge_assignment text not null default 'random'
        check (challenge_assignment in ('random', 'same')),
    enabled_challenges text[] not null default array[
        'own_goal', 'three_demos', 'bump_teammates',
        'lose_kickoffs', 'no_goals', 'stay_in_half'
    ],
    results jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.imposter_players (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.imposter_rooms(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 24),
    ready boolean not null default false,
    created_at timestamptz not null default now(),
    unique (room_id, id)
);

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'imposter_rooms_host_player_fk'
          and conrelid = 'public.imposter_rooms'::regclass
    ) then
        alter table public.imposter_rooms
            add constraint imposter_rooms_host_player_fk
            foreign key (id, host_player_id)
            references public.imposter_players(room_id, id)
            deferrable initially deferred;
    end if;
end;
$$;

create table if not exists public.imposter_player_sessions (
    player_id uuid primary key references public.imposter_players(id) on delete cascade,
    token_hash text not null unique,
    role text check (role in ('imposter', 'safe')),
    challenge text,
    challenge_complete boolean not null default false
);

create table if not exists public.imposter_votes (
    room_id uuid not null references public.imposter_rooms(id) on delete cascade,
    voter_id uuid not null references public.imposter_players(id) on delete cascade,
    suspects uuid[] not null,
    submitted_at timestamptz not null default now(),
    primary key (room_id, voter_id)
);

alter table public.imposter_rooms enable row level security;
alter table public.imposter_players enable row level security;
alter table public.imposter_player_sessions enable row level security;
alter table public.imposter_votes enable row level security;

revoke all on public.imposter_rooms, public.imposter_players,
    public.imposter_player_sessions, public.imposter_votes from anon, authenticated;

create or replace function public.imposter_get_player(p_token text)
returns table(room_id uuid, player_id uuid, player_name text, is_host boolean)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
    select p.room_id, p.id, p.name, (r.host_player_id = p.id)
    from public.imposter_player_sessions s
    join public.imposter_players p on p.id = s.player_id
    join public.imposter_rooms r on r.id = p.room_id
    where p_token is not null
      and s.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function public.imposter_get_state(p_room_id uuid, p_player_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'playerId', p_player_id,
        'role', case when r.phase in ('playing', 'voting', 'results') then own_session.role else null end,
        'challenge', case when r.phase in ('playing', 'voting', 'results') then own_session.challenge else null end,
        'results', case when r.phase = 'results' then r.results else null end,
        'room', jsonb_build_object(
            'id', r.id,
            'code', r.code,
            'phase', r.phase,
            'settings', jsonb_build_object(
                'imposterCount', r.imposter_count,
                'challengeAssignment', r.challenge_assignment,
                'enabledChallenges', r.enabled_challenges
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
            ), '[]'::jsonb)
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

create or replace function public.imposter_broadcast_changes()
returns trigger
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
    v_room_id uuid;
begin
    if tg_table_name = 'imposter_rooms' then
        v_room_id := coalesce(new.id, old.id);
    else
        v_room_id := coalesce(new.room_id, old.room_id);
    end if;

    perform realtime.broadcast_changes(
        'imposter:' || v_room_id::text,
        tg_op,
        tg_op,
        tg_table_name,
        tg_table_schema,
        new,
        old
    );

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

drop trigger if exists imposter_room_broadcast on public.imposter_rooms;
create trigger imposter_room_broadcast
after insert or update or delete on public.imposter_rooms
for each row execute function public.imposter_broadcast_changes();

drop trigger if exists imposter_player_broadcast on public.imposter_players;
create trigger imposter_player_broadcast
after insert or update or delete on public.imposter_players
for each row execute function public.imposter_broadcast_changes();

create or replace function public.imposter_create_room(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_name text;
    v_code text;
    v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_bytes bytea;
    v_token text := encode(extensions.gen_random_bytes(24), 'hex');
    v_room_id uuid := gen_random_uuid();
    v_player_id uuid := gen_random_uuid();
    v_attempt integer;
begin
    v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
    if char_length(v_name) not between 1 and 24 then
        raise exception 'Enter a name of 1-24 characters.';
    end if;

    delete from public.imposter_rooms
    where updated_at < now() - interval '24 hours';

    for v_attempt in 1..30 loop
        v_bytes := extensions.gen_random_bytes(6);
        v_code := '';
        for i in 0..5 loop
            v_code := v_code || substr(
                v_alphabet,
                (get_byte(v_bytes, i) % char_length(v_alphabet)) + 1,
                1
            );
        end loop;
        exit when not exists (
            select 1 from public.imposter_rooms where code = v_code
        );
    end loop;
    if exists (select 1 from public.imposter_rooms where code = v_code) then
        raise exception 'Could not allocate a unique lobby code. Try again.';
    end if;

    insert into public.imposter_rooms (id, code, host_player_id)
    values (v_room_id, v_code, v_player_id);
    insert into public.imposter_players (id, room_id, name)
    values (v_player_id, v_room_id, v_name);
    insert into public.imposter_player_sessions (player_id, token_hash)
    values (
        v_player_id,
        encode(extensions.digest(v_token, 'sha256'), 'hex')
    );

    return public.imposter_get_state(v_room_id, v_player_id)
        || jsonb_build_object('token', v_token);
end;
$$;

create or replace function public.imposter_join_room(p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_room public.imposter_rooms%rowtype;
    v_name text;
    v_token text := encode(extensions.gen_random_bytes(24), 'hex');
    v_player_id uuid := gen_random_uuid();
begin
    v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
    if char_length(v_name) not between 1 and 24 then
        raise exception 'Enter a name of 1-24 characters.';
    end if;

    select * into v_room
    from public.imposter_rooms
    where code = upper(btrim(coalesce(p_code, '')))
    for update;
    if not found or v_room.updated_at < now() - interval '24 hours' then
        raise exception 'That lobby code was not found or has expired.';
    end if;
    if v_room.phase <> 'lobby' then
        raise exception 'This round has already started.';
    end if;
    if (select count(*) from public.imposter_players where room_id = v_room.id) >= 12 then
        raise exception 'This lobby is full.';
    end if;

    insert into public.imposter_players (id, room_id, name)
    values (v_player_id, v_room.id, v_name);
    insert into public.imposter_player_sessions (player_id, token_hash)
    values (
        v_player_id,
        encode(extensions.digest(v_token, 'sha256'), 'hex')
    );
    update public.imposter_rooms set updated_at = now() where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player_id)
        || jsonb_build_object('token', v_token);
end;
$$;

create or replace function public.imposter_resume(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
begin
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    if exists (
        select 1 from public.imposter_rooms
        where id = v_player.room_id
          and updated_at < now() - interval '24 hours'
    ) then
        raise exception 'This lobby session has expired.';
    end if;
    return public.imposter_get_state(v_player.room_id, v_player.player_id);
end;
$$;

create or replace function public.imposter_room_state(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
begin
    select * into v_player from public.imposter_get_player(p_token);
    if not found then
        raise exception 'This lobby session has expired.';
    end if;
    if exists (
        select 1 from public.imposter_rooms
        where id = v_player.room_id
          and updated_at < now() - interval '24 hours'
    ) then
        raise exception 'This lobby session has expired.';
    end if;
    return public.imposter_get_state(v_player.room_id, v_player.player_id);
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
        update public.imposter_rooms
        set host_player_id = v_next_host,
            imposter_count = least(
                imposter_count,
                (select count(*) from public.imposter_players where room_id = v_player.room_id)
            ),
            updated_at = now()
        where id = v_player.room_id;
    end if;
    return jsonb_build_object('left', true);
end;
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
        raise exception 'Ready status cannot be changed now.';
    end if;
    update public.imposter_players
    set ready = p_ready
    where id = v_player.player_id;
    update public.imposter_rooms set updated_at = now() where id = v_room.id;

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
        update public.imposter_player_sessions s
        set role = case when s.player_id = any(v_imposters) then 'imposter' else 'safe' end,
            challenge = case
                when s.player_id <> all(v_imposters) then null
                when v_room.challenge_assignment = 'same' then v_shared_challenge
                else v_room.enabled_challenges[
                    1 + floor(random() * cardinality(v_room.enabled_challenges))::integer
                ]
            end,
            challenge_complete = false
        where s.player_id = any(v_player_ids);
        update public.imposter_rooms
        set phase = 'playing', results = null, updated_at = now()
        where id = v_room.id;
    end if;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_update_settings(
    p_token text,
    p_imposter_count integer,
    p_challenge_assignment text,
    p_enabled_challenges text[]
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
    if v_room.host_player_id <> v_player.player_id or v_room.phase <> 'lobby' then
        raise exception 'Only the host can change lobby settings.';
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
        updated_at = now()
    where id = v_room.id;
    update public.imposter_players set ready = false where room_id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_set_challenge_complete(
    p_token text,
    p_complete boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
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
    if v_room.phase <> 'playing' or not exists (
        select 1 from public.imposter_player_sessions
        where player_id = v_player.player_id and role = 'imposter'
    ) then
        raise exception 'Only an imposter can mark a challenge complete.';
    end if;
    update public.imposter_player_sessions
    set challenge_complete = coalesce(p_complete, false)
    where player_id = v_player.player_id;
    update public.imposter_rooms set updated_at = now() where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_submit_game_stats(
    p_token text,
    p_player_name text,
    p_own_goals integer,
    p_demos integer,
    p_goals integer,
    p_match_ended boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
    v_challenge text;
    v_complete boolean;
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
    select challenge into v_challenge
    from public.imposter_player_sessions
    where player_id = v_player.player_id and role = 'imposter';
    if v_room.phase <> 'playing' or v_challenge is null
       or lower(regexp_replace(btrim(coalesce(p_player_name, '')), '\s+', ' ', 'g'))
            <> lower(v_player.player_name) then
        raise exception 'Game stats do not match the current imposter player.';
    end if;
    if least(coalesce(p_own_goals, 0), coalesce(p_demos, 0), coalesce(p_goals, 0)) < 0 then
        raise exception 'Game stats cannot be negative.';
    end if;
    v_complete := (v_challenge = 'own_goal' and coalesce(p_own_goals, 0) > 0)
        or (v_challenge = 'three_demos' and coalesce(p_demos, 0) >= 3)
        or (v_challenge = 'no_goals' and coalesce(p_match_ended, false)
            and coalesce(p_goals, 0) = 0);
    if v_complete then
        update public.imposter_player_sessions
        set challenge_complete = true
        where player_id = v_player.player_id;
        update public.imposter_rooms set updated_at = now() where id = v_room.id;
    end if;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_match_ended(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
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
    if v_room.host_player_id <> v_player.player_id or v_room.phase <> 'playing' then
        raise exception 'Only the host can end the match.';
    end if;
    update public.imposter_rooms
    set phase = 'voting', updated_at = now()
    where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

create or replace function public.imposter_vote(p_token text, p_suspects uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_player record;
    v_room public.imposter_rooms%rowtype;
    v_suspect_count integer;
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
    if v_room.phase <> 'voting' then
        raise exception 'Voting is not open.';
    end if;
    if exists (
        select 1 from public.imposter_votes
        where room_id = v_room.id and voter_id = v_player.player_id
    ) then
        raise exception 'Your vote has already been submitted.';
    end if;
    if p_suspects is null or cardinality(p_suspects) = 0
       or v_player.player_id = any(p_suspects)
       or cardinality(p_suspects) <> (
           select count(distinct suspect) from unnest(p_suspects) as suspect
       )
       or exists (
           select 1 from unnest(p_suspects) as suspect
           where not exists (
               select 1 from public.imposter_players
               where room_id = v_room.id and id = suspect
           )
       ) then
        raise exception 'Select valid other players to vote for.';
    end if;
    if v_room.imposter_count = 1 and cardinality(p_suspects) <> 1 then
        raise exception 'Select exactly one other player.';
    end if;
    insert into public.imposter_votes (room_id, voter_id, suspects)
    values (v_room.id, v_player.player_id, p_suspects);
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

    update public.imposter_rooms
    set phase = 'results',
        results = jsonb_build_object(
            'tally', v_tally,
            'roles', v_roles,
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
    update public.imposter_player_sessions
    set role = null, challenge = null, challenge_complete = false
    where player_id in (
        select id from public.imposter_players where room_id = v_room.id
    );
    update public.imposter_players set ready = false where room_id = v_room.id;
    update public.imposter_rooms
    set phase = 'lobby', results = null, updated_at = now()
    where id = v_room.id;
    return public.imposter_get_state(v_room.id, v_player.player_id);
end;
$$;

revoke all on function public.imposter_get_player(text) from public, anon, authenticated;
revoke all on function public.imposter_get_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.imposter_broadcast_changes() from public, anon, authenticated;
revoke all on function public.imposter_create_room(text) from public, anon, authenticated;
revoke all on function public.imposter_join_room(text, text) from public, anon, authenticated;
revoke all on function public.imposter_resume(text) from public, anon, authenticated;
revoke all on function public.imposter_room_state(text) from public, anon, authenticated;
revoke all on function public.imposter_leave(text) from public, anon, authenticated;
revoke all on function public.imposter_set_ready(text, boolean) from public, anon, authenticated;
revoke all on function public.imposter_update_settings(text, integer, text, text[]) from public, anon, authenticated;
revoke all on function public.imposter_set_challenge_complete(text, boolean) from public, anon, authenticated;
revoke all on function public.imposter_submit_game_stats(text, text, integer, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.imposter_match_ended(text) from public, anon, authenticated;
revoke all on function public.imposter_vote(text, uuid[]) from public, anon, authenticated;
revoke all on function public.imposter_end_voting(text) from public, anon, authenticated;
revoke all on function public.imposter_next_round(text) from public, anon, authenticated;

grant execute on function public.imposter_create_room(text) to anon, authenticated;
grant execute on function public.imposter_join_room(text, text) to anon, authenticated;
grant execute on function public.imposter_resume(text) to anon, authenticated;
grant execute on function public.imposter_room_state(text) to anon, authenticated;
grant execute on function public.imposter_leave(text) to anon, authenticated;
grant execute on function public.imposter_set_ready(text, boolean) to anon, authenticated;
grant execute on function public.imposter_update_settings(text, integer, text, text[]) to anon, authenticated;
grant execute on function public.imposter_set_challenge_complete(text, boolean) to anon, authenticated;
grant execute on function public.imposter_submit_game_stats(text, text, integer, integer, integer, boolean) to anon, authenticated;
grant execute on function public.imposter_match_ended(text) to anon, authenticated;
grant execute on function public.imposter_vote(text, uuid[]) to anon, authenticated;
grant execute on function public.imposter_end_voting(text) to anon, authenticated;
grant execute on function public.imposter_next_round(text) to anon, authenticated;
