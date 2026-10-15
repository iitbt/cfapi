// 后台用到的目录/文案常量: 唯一来源(照搬旧站 fastapi/app/core/catalog.py)
// 为什么放这里而不是各页面各写一份: 这些值同时被"后台下拉/服务端校验/下发接口"三方读,
// 分散声明就会漂移 —— 旧站为此专门写了三处对齐的注释
// (「我的页菜单」那套常量已随配置页一并删除, 见 2.6.2)

// 运营文案分组(后台筛选用; 顺序即展示顺序)
export const TEXT_GROUPS = ['登录授权', '隐私与关于', '分享'];

// 内置文案的 key 清单: 用于判断"表里缺哪些内置文案"(接口正在用内置默认值)
// 只留 key —— 具体文案由小程序端兜底, 后台不需要它的正文
export const BUILTIN_TEXT_KEYS = [
  'login.wx_auth_info',
  'login.prompt',
  'privacy.fallback',
  'agreement.content',
  'share.default_title',
  'share.default_image',
  'share.topic_template'
];

// 版本更新配置的默认值(表里还没有这一行时用它渲染)
export const DEFAULT_VERSION_INFO = {
  latest_version: '',
  min_version: '',
  update_tip: '发现新版本，更新后体验更好',
  update_content: ''
};
