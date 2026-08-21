import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, ANON, SERVICE_ROLE } from "./_env.mjs";
const GENIUS = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const email = `qa-badge-probe-${Date.now()}@keubo-qa.invalid`;
const { data: created, error: ce } = await admin.auth.admin.createUser({ email, email_confirm: true, password: `Qa!${Math.random().toString(36).slice(2)}Cc3` });
if (ce) throw ce;
const uid = created.user.id;
const convIds = [];
try {
  await admin.from("profiles").upsert({ id: uid, nickname: `QA배지${Date.now()%100000}`, team_id: 1 }, { onConflict: "id" });
  const mk = async (a,b,msg) => {
    const [u1,u2] = [a,b].sort();
    const { data, error } = await admin.from("dm_conversations").insert({ user1_id:u1, user2_id:u2, last_message:msg, last_message_at:new Date().toISOString() }).select("id").single();
    if (error) throw error; convIds.push(data.id); return data.id;
  };
  const gConv = await mk(uid, GENIUS, "[QA] bot");
  const { data: buddy } = await admin.auth.admin.createUser({ email:`qa-badge-buddy-${Date.now()}@keubo-qa.invalid`, email_confirm:true, password:`Qa!x${Math.random().toString(36).slice(2)}Dd4` });
  const bid = buddy.user.id;
  const bConv = await mk(uid, bid, "[QA] normal");
  const { error: me1 } = await admin.from("dm_messages").insert([
    { conversation_id:gConv, sender_id:GENIUS, content:"[QA] bot unread", is_read:false },
    { conversation_id:bConv, sender_id:bid, content:"[QA] normal unread", is_read:false },
  ]);
  if (me1) throw me1;
  // 유저 JWT 확보
  const { data: link } = await admin.auth.admin.generateLink({ type:"magiclink", email });
  const vr = await fetch(`${SUPABASE_URL}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink`, { redirect:"manual" });
  const frag = new URLSearchParams((vr.headers.get("location")||"").split("#")[1]||"");
  const token = frag.get("access_token");
  const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { autoRefreshToken:false, persistSession:false } });
  const q = await userClient.from("dm_conversations").select("id, user1_id, user2_id")
    .or(`user1_id.eq.${uid},user2_id.eq.${uid}`)
    .not("user1_id","eq",GENIUS).not("user2_id","eq",GENIUS)
    .order("last_message_at",{ascending:false}).limit(500);
  console.log("convs error:", q.error?.message ?? null, "rows:", q.data?.length);
  console.log("rows:", JSON.stringify(q.data));
  const filteredIds = (q.data??[]).filter(c=>c.user1_id!==GENIUS&&c.user2_id!==GENIUS).map(c=>c.id);
  const rpc = await userClient.rpc("dm_unread_counts", { p_conversation_ids: filteredIds });
  console.log("rpc error:", rpc.error?.message ?? null, "rows:", JSON.stringify(rpc.data));
  const total = (rpc.data??[]).reduce((t,r)=>t+Number(r.unread_count),0);
  console.log("TOTAL BADGE =", total);
} finally {
  for (const id of convIds) { await admin.from("dm_messages").delete().eq("conversation_id", id); await admin.from("dm_conversations").delete().eq("id", id); }
  const { data: us } = await admin.auth.admin.listUsers({ perPage: 200 });
  for (const u of us?.users ?? []) if (u.email?.startsWith("qa-badge-")) { await admin.from("profiles").delete().eq("id", u.id); await admin.auth.admin.deleteUser(u.id); }
  console.log("cleanup done");
}
