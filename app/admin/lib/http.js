// 后台响应拼装 —— **全后台唯一实现**。
// 为什么单独一个文件: json() 与 redirect() 以前散在十几个页面模块里各写一份(签名还分叉: 有的带 status、
// 有的带 cookie), 改一次响应头/重定向口径就要改十几处, 而那正是最容易漏的地方。
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

/** 302 跳转; 传了 cookie 就一并下发 Set-Cookie(登录/登出/改密这类要换会话的流程用)。 */
export function redirect(location, cookie) {
  const headers = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}
