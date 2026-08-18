// functions/score/index.ts —— 提交成绩（token 归属校验 + 库内 RPC 反作弊）
// 部署：Supabase Dashboard → Edge Functions → score → 粘贴 → Deploy
// 排行榜查询不走本函数：前端 REST 公开只读（RLS read_any 保留）
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
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
  "https://kazuha233.github.io",
  "https://nailong-run3.netlify.app",   // 线上 Netlify 测试版
  "null",
  "http://localhost", "http://127.0.0.1",
];
function originOk(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return false;
  return ALLOWED_ORIGINS.some(a => o === a || (a.startsWith("http") && o.startsWith(a + ":")));
}
const isStr = (v: unknown, min: number, max: number) =>
  typeof v === "string" && v.length >= min && v.length <= max;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!originOk(req)) return json({ error: "forbidden" }, 403);   // ⚠️ Origin 白名单校验
  let body; try { body = await req.json(); } catch { return json({ error: "invalid_request" }, 400); }
  const { nickname, token, score, elapsed, avatar, mode } = body;

  // ① 参数类型校验（防畸形请求，省库查询）
  if (!isStr(nickname, 1, 10)) return json({ error: "invalid_request" }, 400);
  if (!isStr(token, 1, 64)) return json({ error: "invalid_request" }, 400);
  const scMode = mode === "endless" ? "endless" : "extreme";   // 模式白名单：只认 endless，其余按 extreme
  const scMax = scMode === "endless" ? 999999 : 9999;         // 无尽上限 999999（≈11.1h 存活）；极限 9999
  if (!isNum(score) || score < 0 || score > scMax) return json({ error: "invalid_request" }, 400);
  if (elapsed !== undefined && (!isNum(elapsed) || elapsed < 0)) return json({ error: "invalid_request" }, 400);
  if (avatar !== undefined && avatar !== null &&
      (typeof avatar !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(avatar) || avatar.length > 40000))
    return json({ error: "invalid_request" }, 400);

  // ② token 归属校验（防冒名：别人的 token 改不了你的数据）
  const { data: u } = await sb.from("users").select("id")
    .eq("nickname", nickname).eq("token", token)
    .gte("token_ts", new Date(Date.now() - 30 * 86400000).toISOString()).maybeSingle();
  if (!u) return json({ error: "invalid_request" }, 400);

  // ③ 反作弊交给库内 RPC（限流/偏差≤20%/超速约束；service_role 调用，匿名不可达）
  //    头像随分数一起落库（未上榜玩家 setAvatar 时 update 0 行，在此补上）
  //    ⚠️ 新 5 参数重载：p_mode=endless → 无条件覆盖（无尽分数覆盖极限成绩，紫）；extreme → 更高分保留
  const { error } = await sb.rpc("upsert_leaderboard", {
    p_nickname: nickname, p_score: score, p_elapsed: elapsed || 0, p_avatar: avatar ?? null, p_mode: scMode,
  });
  if (error) return json({ error: "invalid_request" }, 400);
  return json({ ok: true });
});
