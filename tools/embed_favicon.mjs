// 把仓库里的图片内联成 Worker 内的模块(生成物, 不要手改):
//   app/favicon.ico → app/core/favicon.js（站点图标, 路由 /favicon.ico）
//   app/lucky.jpg   → app/core/lucky.js  （后台图片兜底图, 路由 /lucky.jpg）
// 用法: node tools/embed_favicon.mjs; 换了图就重跑并升 API_VERSION(见 DEPLOY.md「站点图标」/「图片兜底图」)
// 为什么内联而不放 R2: 每个页面(含未登录的登录页)都要能拿到, 且不该依赖"桶里恰好有那张对象" —— 少一次子请求, 也不会因为素材被清理而失效
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// 文件头 → content-type: 声明必须与真实字节一致(类型不符 + nosniff 会被挑剔的客户端直接丢掉)
function contentTypeOf(bytes) {
  const head = bytes.subarray(0, 12).toString('hex');
  if (head.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (head.startsWith('ffd8ff')) return 'image/jpeg';
  if (head.startsWith('474946383')) return 'image/gif';
  if (head.startsWith('52494646')) return 'image/webp';
  if (head.startsWith('00000100')) return 'image/x-icon';
  return 'application/octet-stream';
}

const TARGETS = [
  {
    source: 'app/favicon.ico', target: 'app/core/favicon.js', prefix: 'FAVICON',
    label: '站点图标(favicon.ico)', route: '/favicon.ico', maxAge: 604800,
    notes: [
      '内联成 base64 而不从 R2 取(每个页面、未登录都要能拿到); 生成方式: node tools/embed_favicon.mjs',
      '页面侧拼成 /favicon.ico?v=<指纹>, 让浏览器换掉"本站没有图标"的旧记忆'
    ],
    tail: `/** /favicon.ico 的响应: 根绝对路径(自定义域与预览域都成立), 必须由 Worker 自己响应, 见 DEPLOY.md。 */`
  },
  {
    source: 'app/lucky.jpg', target: 'app/core/lucky.js', prefix: 'LUCKY',
    label: '后台图片兜底图(lucky.jpg)', route: '/lucky.jpg', maxAge: 604800,
    notes: [
      '内联成 base64 而不从 R2 取: 后台各页的图片加载失败时都要能立刻显示它, 且不该依赖"桶里恰好有这张对象"',
      '页面侧拼成 /lucky.jpg?v=<指纹>(见 admin/lib/partials.js 的 IMAGE_FALLBACK_SRC), 换图后浏览器不会继续用旧缓存'
    ],
    tail: `/** /lucky.jpg 的响应: 与 favicon 同一手法(Worker 直出内联字节), 供后台各页的图片兜底使用。 */`
  }
];

for (const target of TARGETS) {
  const source = resolve(root, target.source);
  const bytes = await readFile(source);
  const base64 = bytes.toString('base64');
  const etag = createHash('md5').update(bytes).digest('hex').slice(0, 16);
  const name = target.prefix;
  const body = `// ${target.label}的唯一来源 —— 与 fastapi/${target.source} 是同一个文件(${bytes.length} 字节)
// ${target.notes[0]}
const ${name}_BASE64 = '${base64}';

//: 声明真实类型(按文件头判定): 类型与字节不一致 + nosniff 会被挑剔的客户端直接丢掉
export const ${name}_CONTENT_TYPE = '${contentTypeOf(bytes)}';

//: 内容指纹做 ETag: 图不变则标签不变, 浏览器可走 304
export const ${name}_ETAG = '"${etag}"';

//: 纯指纹(不带引号): ${target.notes[1]}
export const ${name}_HASH = '${etag}';

//: 路由(根绝对路径): 见 main.js 的分发
export const ${name}_PATH = '${target.route}';

let cached = null;

/** ${target.label}原始字节(首次调用解码, 之后复用)。 */
export function ${name.toLowerCase()}Bytes() {
  if (cached) return cached;
  const binary = atob(${name}_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  cached = bytes;
  return cached;
}

${target.tail}
export function ${name.toLowerCase()}Response() {
  const bytes = ${name.toLowerCase()}Bytes();
  return new Response(bytes, {
    headers: {
      'content-type': ${name}_CONTENT_TYPE,
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=${target.maxAge}',
      etag: ${name}_ETAG
    }
  });
}
`;
  const file = resolve(root, target.target);
  await writeFile(file, body, 'utf8');
  console.log(`已生成 ${target.target}（${target.label}, ${bytes.length} 字节 → base64 ${base64.length} 字符）`);
}
