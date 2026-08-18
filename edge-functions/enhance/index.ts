// functions/enhance/index.ts —— 加点/结晶同步（token 归属校验 → 库内白名单 RPC）
// 部署：Supabase Dashboard → Edge Functions → enhance → 粘贴 → Deploy
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
const ENHANCE_KEYS = ["crystal", "maxLv", "regenLv", "char"];   // 加点/结晶/当前角色（数值 0~100000/0~999；char 白名单字符串）

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!originOk(req)) return json({ error: "forbidden" }, 403);   // ⚠️ Origin 白名单校验
  let body; try { body = await req.json(); } catch { return json({ error: "invalid_request" }, 400); }
  const { nickname, token, enhance } = body;

  // ① 参数校验（4 key 白名单：数字 0~100000/0~999；char 仅 nailong/yishen）
  if (!isStr(nickname, 1, 10)) return json({ error: "invalid_request" }, 400);
  if (!isStr(token, 1, 64)) return json({ error: "invalid_request" }, 400);
  if (enhance === undefined || enhance === null || typeof enhance !== "object" || Array.isArray(enhance))
    return json({ error: "invalid_request" }, 400);
  for (const k of Object.keys(enhance)) {
    if (!ENHANCE_KEYS.includes(k)) return json({ error: "invalid_request" }, 400);
    if (k === "char") {
      if (enhance[k] !== "nailong" && enhance[k] !== "yishen") return json({ error: "invalid_request" }, 400);
      continue;
    }
    if (typeof enhance[k] !== "number" || !Number.isFinite(enhance[k])) return json({ error: "invalid_request" }, 400);
    // 云端权威上限（防篡改刷数值）：结晶 0~100000；等级 0~999
    if (k === "crystal" && (enhance[k] < 0 || enhance[k] > 100000)) return json({ error: "invalid_request" }, 400);
    if (k !== "crystal" && (enhance[k] < 0 || enhance[k] > 999)) return json({ error: "invalid_request" }, 400);
  }

  // ② token 归属校验（防冒名篡改他人加点/结晶）
  const { data: u } = await sb.from("users").select("id")
    .eq("nickname", nickname).eq("token", token)
    .gte("token_ts", new Date(Date.now() - 30 * 86400000).toISOString()).maybeSingle();
  if (!u) return json({ error: "invalid_request" }, 400);

  // ③ 库内 RPC：白名单校验
  const { error } = await sb.rpc("sync_enhance", {
    p_nickname: nickname, p_enhance: enhance,
  });
  if (error) return json({ error: "invalid_request" }, 400);
  return json({ ok: true });
});
