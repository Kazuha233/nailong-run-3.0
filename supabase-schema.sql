-- ============================================================
-- 奶龙快跑 3.0 🦖 · Supabase 数据库 Schema（强化反作弊版）
-- 适用项目：https://flhopneudhhwweclcvmo.supabase.co
-- 维护：cat-bot（绒喵）· 2026-08-14 同步数据库权威版
-- 说明：整段幂等，可重复执行（先 drop 再 create / if not exists）
-- ============================================================

-- ---------- 1. users 表（注册/登录） ----------
create table if not exists users (
  id bigint generated always as identity primary key,
  nickname text not null unique,
  password text not null,          -- 前端 SHA-256 哈希（64 位 hex），非明文
  achievements jsonb default '{}'::jsonb,
  enhance jsonb default '{"crystal":0,"maxLv":0,"regenLv":0,"char":"nailong"}'::jsonb,  -- 强化加点+结晶+当前角色
  token text,                      -- Edge Function 签发会话令牌（UUID）
  token_ts timestamptz default now(),   -- 令牌签发时间（30 天过期校验，VULN-09 缓解）
  fail_count int default 0,        -- 登录失败计数（防爆破）
  last_fail timestamptz,           -- 上次失败时间
  reward10 boolean default false,  -- 🎁 登录礼包（10 能源结晶）领取标记：每人一次
  created_at timestamptz default now()
);

alter table users enable row level security;

drop policy if exists "insert_user" on users;
drop policy if exists "read_user" on users;
create policy "insert_user" on users for insert
  with check (char_length(nickname) between 1 and 12
              and char_length(password) between 8 and 64);
create policy "read_user" on users for select using (true);

-- ---------- 2. leaderboard 表（极限/无尽双模式排行榜） ----------
create table if not exists leaderboard (
  id bigint generated always as identity primary key,
  nickname text not null unique,   -- 一人一条记录（单位制：无尽紫 > 极限黄）
  score int not null,
  equip text,                      -- 佩戴成就 key
  avatar text,                     -- 头像 dataURL（随分数落库）
  mode text default 'extreme',     -- extreme（黄）/ endless（紫，无尽优先展示）
  created_at timestamptz default now()
);

alter table leaderboard enable row level security;

drop policy if exists "read_any" on leaderboard;
drop policy if exists "insert_valid" on leaderboard;
create policy "read_any" on leaderboard for select using (true);
create policy "insert_valid" on leaderboard for insert
  with check (score between 0 and 999999 and nickname is not null
              and char_length(nickname) between 1 and 12);

-- ---------- 3. score_log 表（每次提交历史：分数合理性校验依据） ----------
create table if not exists score_log (
  id bigint generated always as identity primary key,
  nickname text not null,
  score int not null,
  created_at timestamptz default now()
);
alter table score_log enable row level security;
drop policy if exists "insert_log" on score_log;
drop policy if exists "read_log" on score_log;
create policy "insert_log" on score_log for insert with check (true);
create policy "read_log" on score_log for select using (true);

-- ---------- 4. 统一令牌校验 RPC（防冒名 + 30 天过期） ----------
-- 5 个 Edge Function（auth/score/equip/achieve/enhance）统一调用；security definer 走 owner 权限
create or replace function check_token(p_nickname text, p_token text)
returns boolean as $$
begin
  return exists (
    select 1 from users
    where nickname = p_nickname and token = p_token
      and token_ts > now() - interval '30 days'
  );
end $$ language plpgsql security definer;

-- ---------- 5. 榜单 RPC（随枫反作弊系统 4.0 · 双模式 v4） ----------
-- 一人一条只留最高分；覆盖时刷新 created_at（同分越早越前）
-- 防线：
--   ① 限流：同昵称 60 秒内只接受 1 次提交（挡外挂连刷/批量改分）
--   ② 模式分速校验（偏差 ≤20%）：
--      极限：score/9999 ≈ elapsed/231（BGM 231.2s），9999 分必须 elapsed∈[163s,243s]
--      无尽：score ≈ elapsed×25（25 分/秒），偏差 >20% 拒绝
--   ③ 超速约束（极限）：分数 ≤ elapsed×60+200（正常 49.3 分/秒，上限 60）
--   ④ 旧校验保留：距上次提交 <30 秒涨幅 >3000 → 拒绝（极限）
--   ⑤ 跨提交时间连续性：本次声称 elapsed 不得超过距上次提交的真实墙钟间隔+30s
-- 落库规则（2026-08-14 单位制）：一人一条；无尽（紫）单位 > 极限（黄）单位
--   - 无尽提交：已有无尽 → 更高分才更新；已有极限 → 无条件顶替为 endless（单位大）
--   - 极限提交：已有无尽 → 永不覆盖（单位小）；已有极限 → 更高分才更新
--   - 效果：玩家一旦打出无尽成绩，极限成绩永远无法顶掉它（显示紫）；只有无尽更高分才更新
CREATE OR REPLACE FUNCTION public.upsert_leaderboard(p_nickname text, p_score integer, p_elapsed integer DEFAULT 0, p_avatar text DEFAULT NULL::text, p_mode text DEFAULT 'extreme'::text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
 AS $function$















      declare















        dev float;















        last_ts timestamptz;















        last_score int;















        dt_sec float;















      begin















        if p_nickname is null or char_length(p_nickname) < 1 or char_length(p_nickname) > 10 then















          raise exception 'invalid nickname';















        end if;















        if p_mode not in ('extreme', 'endless') then















          raise exception 'invalid mode';















        end if;















        if p_score < 0 or (p_mode = 'extreme' and p_score > 9999) or (p_mode = 'endless' and p_score > 999999) then















          raise exception 'invalid score';















        end if;































        -- ① 限流：同昵称 60 秒内 1 次















        if exists (select 1 from score_log where nickname = p_nickname and created_at > now() - interval '60 seconds') then















          raise exception 'too frequent';















        end if;















        insert into score_log (nickname, score) values (p_nickname, p_score);































        if p_mode = 'extreme' then















          -- 极限：原匀速校验（9999/231s）+ 超速 + 连续性















          if p_elapsed > 0 and p_score > 500 then















            dev := abs((p_score::float / 9999.0) - (p_elapsed::float / 231.0));















            if dev > 0.20 then raise exception 'suspicious score'; end if;















            if p_score > p_elapsed * 60 + 200 then raise exception 'suspicious score'; end if;















          end if;















          select created_at, score into last_ts, last_score















          from score_log where nickname = p_nickname















          order by created_at desc limit 1 offset 1;















          if last_ts is not null then















            dt_sec := extract(epoch from (now() - last_ts));















            if p_score - last_score > 3000 and dt_sec < 30 then raise exception 'suspicious score'; end if;















          end if;















          select created_at into last_ts















          from score_log where nickname = p_nickname















          order by created_at desc limit 1 offset 1;















          if last_ts is not null and p_elapsed > 0 then















            dt_sec := extract(epoch from (now() - last_ts));















            if p_elapsed > dt_sec + 30 then raise exception 'suspicious score'; end if;















          end if;















        else















          -- 无尽：25 分/秒匀速校验（偏差 ≤20%）+ 连续性（跳过极限的 9999/231 基准）















          if p_elapsed > 0 and p_score > 300 then















            dev := abs((p_score::float / p_elapsed) - 25.0) / 25.0;















            if dev > 0.20 then raise exception 'suspicious score'; end if;















          end if;















          select created_at into last_ts















          from score_log where nickname = p_nickname















          order by created_at desc limit 1 offset 1;















          if last_ts is not null and p_elapsed > 0 then















            dt_sec := extract(epoch from (now() - last_ts));















            if p_elapsed > dt_sec + 30 then raise exception 'suspicious score'; end if;















          end if;















        end if;































        -- 落库：无尽 = 无条件覆盖（分数 + mode 变 endless，紫）；极限 = 更高分才覆盖（mode 保持，无尽不被盖回黄）















        if p_mode = 'endless' then















          insert into leaderboard (nickname, score, avatar, mode) values (p_nickname, p_score, p_avatar, 'endless')















          on conflict (nickname) do update set score = excluded.score, created_at = now(), mode = 'endless',

         avatar = coalesce(excluded.avatar, leaderboard.avatar) where leaderboard.mode <> 'endless' or leaderboard.score < excluded.score;















        else















          insert into leaderboard (nickname, score, avatar, mode) values (p_nickname, p_score, p_avatar, 'extreme')















          on conflict (nickname) do update set score = excluded.score, created_at = now(),

         avatar = coalesce(excluded.avatar, leaderboard.avatar) where leaderboard.mode <> 'endless' and leaderboard.score < excluded.score;















        end if;















        return 'ok';















      end $function$;

-- ---------- 6. 佩戴 RPC：白名单校验（13 成就 key） ----------
create or replace function update_equip(p_nickname text, p_equip text)
returns text as $$
begin
  if p_nickname is null or char_length(p_nickname) < 1 or char_length(p_nickname) > 10 then
    raise exception 'invalid nickname';
  end if;
  if p_equip is not null and p_equip not in ('summit','extremeWin','fish6','heliMan','crocHit','snowWalker','thornWalker','unique',
      'snowDaughter','ironWall','endlessEra','faceIt','kingTop') then
    raise exception 'invalid equip';
  end if;
  update leaderboard set equip = p_equip where nickname = p_nickname;
  return 'ok';
end $$ language plpgsql security definer;

-- ---------- 7. 成就同步 RPC：白名单校验（13 成就 key，布尔值） ----------
create or replace function sync_achievements(p_nickname text, p_ach jsonb)
returns text as $$
declare
  k text;
begin
  if p_nickname is null or char_length(p_nickname) < 1 or char_length(p_nickname) > 10 then
    raise exception 'invalid nickname';
  end if;
  for k in select jsonb_object_keys(p_ach) loop
    if k not in ('summit','extremeWin','fish6','heliMan','crocHit','snowWalker','thornWalker','unique',
                 'snowDaughter','ironWall','endlessEra','faceIt','kingTop') then
      raise exception 'invalid achievement key: %', k;
    end if;
    if jsonb_typeof(p_ach -> k) <> 'boolean' then
      raise exception 'invalid achievement value';
    end if;
  end loop;
  update users set achievements = p_ach where nickname = p_nickname;
  return 'ok';
end $$ language plpgsql security definer;

-- ============================================================
-- 成就 key 白名单（13 个，前端 ACHIEVEMENTS 与上述函数必须一致）：
--   summit      🏔️ 抵达雪峰    任意模式到达终点（best≥9999）
--   extremeWin  👑 极限雪峰    极限模式下到达终点（解锁无尽模式）
--   fish6       🐟 年年有鱼    终点剩余奶鱼≥6
--   heliMan     🚁 Man！       一局护体撞碎 6 架直升机
--   crocHit     🐊 鳄啊~       一局撞击 5 只鳄鱼
--   snowWalker  ❄️ 雪地行者    不耗奶鱼在一场雪天中存活
--   thornWalker 🌵 荆棘行者    荆棘缠身连续前进 2000 分
--   snowDaughter ☃️ 风雪压我千百年  身上有细雪时连续前进 1600 分
--   ironWall    🧱 铜墙铁壁    无尽模式撞击阈值
--   endlessEra  ♾️ 无尽时代    无尽模式达到 1314 分
--   faceIt      😤 直面恐惧    撞碎 1 架吊货直升机
--   kingTop     🏆 万人之上    成为排行榜第一
--   unique      💎 举世无双    完成以上所有成就
-- ============================================================

-- ---------- 8. 加点/结晶同步 RPC：白名单（crystal/maxLv/regenLv 数字 + char 字符串） ----------
alter table users add column if not exists enhance jsonb default '{"crystal":0,"maxLv":0,"regenLv":0,"char":"nailong"}'::jsonb;

create or replace function sync_enhance(p_nickname text, p_enhance jsonb)
returns text as $$
declare
  k text;
begin
  if p_nickname is null or char_length(p_nickname) < 1 or char_length(p_nickname) > 10 then
    raise exception 'invalid nickname';
  end if;
  if p_enhance is null or jsonb_typeof(p_enhance) <> 'object' then
    raise exception 'invalid enhance';
  end if;
  for k in select jsonb_object_keys(p_enhance) loop
    if k not in ('crystal','maxLv','regenLv','char') then
      raise exception 'invalid enhance key: %', k;
    end if;
    -- char：当前角色（字符串白名单 nailong/yishen）
    if k = 'char' then
      if jsonb_typeof(p_enhance -> k) <> 'string' or (p_enhance -> k)::text not in ('"nailong"','"yishen"') then
        raise exception 'invalid enhance char';
      end if;
      continue;
    end if;
    if jsonb_typeof(p_enhance -> k) <> 'number' then
      raise exception 'invalid enhance value';
    end if;
    -- 云端权威上限（防篡改刷数值）：结晶 0~100000；等级 0~999（强化加成上限防溢出）
    if k = 'crystal' and ((p_enhance -> k)::numeric < 0 or (p_enhance -> k)::numeric > 100000) then
      raise exception 'enhance out of range';
    end if;
    if k <> 'crystal' and ((p_enhance -> k)::numeric < 0 or (p_enhance -> k)::numeric > 999) then
      raise exception 'enhance level out of range';
    end if;
  end loop;
  update users set enhance = p_enhance where nickname = p_nickname;
  return 'ok';
end $$ language plpgsql security definer;

-- ---------- 9. 登录礼包领取 RPC（10 能源结晶；reward10 标记原子防重复） ----------
create or replace function claim_reward10(p_nickname text)
returns jsonb as $$
declare
  new_enhance jsonb;
begin
  if p_nickname is null or char_length(p_nickname) < 1 or char_length(p_nickname) > 10 then
    raise exception 'invalid nickname';
  end if;
  update users set
    reward10 = true,
    enhance = jsonb_set(enhance, '{crystal}', ((coalesce((enhance->>'crystal')::int, 0) + 10))::text::jsonb)
  where nickname = p_nickname and reward10 = false
  returning enhance into new_enhance;
  if new_enhance is null then
    raise exception 'already claimed';
  end if;
  return new_enhance;
end $$ language plpgsql security definer;
