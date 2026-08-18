// functions/auth/index.ts —— 注册 / 登录 / 改密码 / 获取资料（token 签发与归属校验）
// 部署：Supabase Dashboard → Edge Functions → auth → 粘贴 → Deploy
import { createClient } from "jsr:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!   // ⚠️ 只存在服务端环境变量，绝不进前端
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

// ---- 网络请求校验：Origin 白名单（防 curl/脚本/外挂页裸调）----
const ALLOWED_ORIGINS = [
  "https://kazuha233.github.io",   // 线上 GitHub Pages
  "https://nailong-run3.netlify.app",   // 线上 Netlify 测试版
  "null",                           // file:// 本地预览
  "http://localhost", "http://127.0.0.1",  // 本地开发
];
function originOk(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return false;                              // 非浏览器调用（curl/python/脚本）直接拒
  return ALLOWED_ORIGINS.some(a => o === a || (a.startsWith("http") && o.startsWith(a + ":")));
}
const isStr = (v: unknown, min: number, max: number) =>
  typeof v === "string" && v.length >= min && v.length <= max;

const sha256hex = async (s: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!originOk(req)) return json({ error: "forbidden" }, 403);   // ⚠️ Origin 白名单校验
  let body; try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { action, nickname, password, oldPassword, newPassword, token } = body;

  if (!isStr(nickname, 1, 10))
    return json({ error: "invalid_nickname" }, 400);

  // ---------- 注册 ----------
  if (action === "register") {
    if (!password || password.length < 6 || password.length > 64)
      return json({ error: "invalid_password" }, 400);
    const { data: dup } = await sb.from("users").select("id").eq("nickname", nickname).maybeSingle();
    if (dup) return json({ error: "nickname_taken" }, 409);
    const t = crypto.randomUUID();
    const { error } = await sb.from("users").insert({
      nickname, pass_hash: bcrypt.hashSync(password, 10), achievements: {}, token: t, token_ts: new Date().toISOString(),
    });
    if (error) return json({ error: "register_failed", detail: error.message }, 400);   // 【诊断用】上线前可移除 detail
    return json({ ok: true, token: t, nickname });
  }

  // ---------- 登录（含懒迁移旧 SHA-256 + 防爆破） ----------
  if (action === "login") {
    if (!password) return json({ error: "invalid_password" }, 400);
    const { data: u } = await sb.from("users")
      .select("id, pass_hash, password, fail_count, last_fail")
      .eq("nickname", nickname).maybeSingle();
    if (!u) return json({ error: "no_user" }, 401);
    if (u.fail_count >= 5 && u.last_fail &&
        Date.now() - new Date(u.last_fail).getTime() < 15 * 60 * 1000)
      return json({ error: "locked" }, 429);

    let ok = false, migrated = false;
    if (u.pass_hash) ok = bcrypt.compareSync(password, u.pass_hash);
    else if (u.password && await sha256hex(password) === u.password) { ok = true; migrated = true; }

    if (!ok) {
      await sb.from("users").update({
        fail_count: (u.fail_count ?? 0) + 1, last_fail: new Date().toISOString(),
      }).eq("id", u.id);
      return json({ error: "bad_password" }, 401);
    }
    const t = crypto.randomUUID();
    await sb.from("users").update({
      token: t, token_ts: new Date().toISOString(), fail_count: 0, last_fail: null,
      pass_hash: u.pass_hash ?? bcrypt.hashSync(password, 10),
      password: migrated ? null : u.password,
    }).eq("id", u.id);
    return json({ ok: true, token: t, nickname });
  }

  // ---------- 改密码（验旧密码 + 吊销旧 token） ----------
  if (action === "changePassword") {
    if (!token) return json({ error: "auth_failed" }, 401);
    if (!oldPassword || !newPassword || newPassword.length < 6 || newPassword.length > 64)
      return json({ error: "invalid_password" }, 400);
    const { data: u } = await sb.from("users")
      .select("id, pass_hash").eq("nickname", nickname).eq("token", token)
      .gte("token_ts", new Date(Date.now() - 30 * 86400000).toISOString()).maybeSingle();
    if (!u || !u.pass_hash || !bcrypt.compareSync(oldPassword, u.pass_hash))
      return json({ error: "auth_failed" }, 401);
    const t = crypto.randomUUID();
    await sb.from("users").update({
      pass_hash: bcrypt.hashSync(newPassword, 10), token: t, token_ts: new Date().toISOString(), password: null,
    }).eq("id", u.id);
    return json({ ok: true, token: t });
  }

  // ---------- 获取个人资料（成就 + 加点/结晶 + 装备 + 头像 + 登录礼包状态；users RLS 已关，走服务端） ----------
  if (action === "getProfile") {
    if (!token) return json({ error: "auth_failed" }, 401);
    const { data: u } = await sb.from("users")
      .select("achievements, enhance, reward10").eq("nickname", nickname).eq("token", token)
      .gte("token_ts", new Date(Date.now() - 30 * 86400000).toISOString()).maybeSingle();
    if (!u) return json({ error: "auth_failed" }, 401);
    const { data: lb } = await sb.from("leaderboard")
      .select("equip, avatar").eq("nickname", nickname).maybeSingle();
    return json({ ok: true, achievements: u.achievements || {}, enhance: u.enhance || { crystal: 0, maxLv: 0, regenLv: 0 }, equip: (lb && lb.equip) || null, avatar: (lb && lb.avatar) || null, reward10: !!u.reward10 });
  }

  // ---------- 领取登录礼包（10 能源结晶，每人一次；RPC 原子防重复） ----------
  if (action === "claimReward") {
    if (!token) return json({ error: "auth_failed" }, 401);
    const { data: u } = await sb.from("users").select("id")
      .eq("nickname", nickname).eq("token", token)
      .gte("token_ts", new Date(Date.now() - 30 * 86400000).toISOString()).maybeSingle();
    if (!u) return json({ error: "auth_failed" }, 401);
    const { data, error } = await sb.rpc("claim_reward10", { p_nickname: nickname });
    if (error) return json({ error: "already_claimed" }, 409);   // 已领取/异常 → 409
    return json({ ok: true, enhance: data });
  }

  // ---------- 设置头像（dataURL 存 leaderboard.avatar，公开可读供查榜带出） ----------
  if (action === "setAvatar") {
    if (!token) return json({ error: "auth_failed" }, 401);
    const av = body.avatar;
    if (typeof av !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(av) || av.length > 40000)
      return json({ error: "invalid_avatar" }, 400);     // 114×114 JPEG 通常 1~10KB，40KB 上限足够
    const { data: u } = await sb.from("users").select("id")
      .eq("nickname", nickname).eq("token", token)
      .gte("token_ts", new Date(Date.now() - 30 * 86400000).toISOString()).maybeSingle();
    if (!u) return json({ error: "auth_failed" }, 401);
    // ⚠️ 只 update 头像列（绝不 upsert 整行——score NOT NULL，且 upsert 会覆盖分数）
    // 未上榜玩家 update 0 行也返回 ok：本地头像会在下次提交分数时随 RPC 一起落库
    await sb.from("leaderboard").update({ avatar: av }).eq("nickname", nickname);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
