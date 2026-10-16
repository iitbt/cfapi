/**
 * 素材库弹窗(「从素材库选择」)的**唯一实现**: 服务笔记编辑(news_edit)与专题编辑(topic_edit)两个页面,
 * 以前只写在 news_edit 里, 别的页面要用就得复制一份。
 *
 * 页面需要做两件事:
 *   ① 引入标记(弹窗 HTML 由 lib/partials.js 的 mediaLibraryModal 渲染, 外壳统一加本脚本);
 *   ② 若该页面需要"把素材插进富文本", 提供 window.MediaInsertFromLibrary(path, kind);
 *      只往输入框里写值(input 模式)的页面什么都不用提供。
 *
 * 打开弹窗的按钮上用 data-* 说明本次行为:
 *   data-media-mode input|editor / data-media-kind image|video /
 *   data-media-lock-kind "1" / data-media-target / data-media-preview
 *
 * 列表是**逐层浏览 + 触底加载**: 取数、过滤、排序、分页与行 HTML 全在服务端(lib/mediaBrowse.js,
 * 与素材库治理页同一份), 这里只负责拼 URL、追加行、画面包屑与子目录按钮。
 * 为什么不再"一次列出全桶": 那样一撞到单次列举上限(1000)就静默截断, 表现就是"部分图片列不出来";
 * 而且旧实现把缩略图拼成站点根路径, 凡不在 Worker 直出前缀里的对象一律裂图 —— 现在地址由服务端按媒体公开域拼。
 */
(function () {
  'use strict';

  // 幂等守卫: 同一页面重复引入本脚本时只绑定一次(外壳统一引 + 页面若再引一份也不会重复插值)
  if (window.__mediaLibraryBound) { return; }
  window.__mediaLibraryBound = true;

  var mediaModal = document.getElementById('mediaLibraryModal');
  var mediaListEl = document.getElementById('mediaLibraryList');        // 表格 <tbody>
  var mediaScrollEl = document.getElementById('mediaLibraryScroll');    // 滚动容器(触底判定的 root)
  var mediaMoreEl = document.getElementById('mediaLibraryLoadMore');    // 触底哨兵
  var mediaMoreTextEl = document.getElementById('mediaLibraryLoadMoreText');
  var mediaCrumbsEl = document.getElementById('mediaLibraryCrumbs');
  var mediaDirsEl = document.getElementById('mediaLibraryDirs');
  var mediaQueryEl = document.getElementById('mediaLibraryQuery');
  var mediaHintEl = document.getElementById('mediaLibraryHint');
  var mediaManualEl = document.getElementById('mediaLibraryManual');
  var mediaKindBtns = mediaModal ? mediaModal.querySelectorAll('[data-media-kind-btn]') : [];
  var mediaKindGroupEl = document.getElementById('mediaLibraryKindSwitch');
  var mediaTitleEl = document.getElementById('mediaLibraryModalLabel');
  var mediaMode = 'editor';   // 由打开弹窗的按钮决定
  var mediaKind = 'image';    // 当前分类(图片/视频): 由按钮决定, 弹窗内可切换
  // 分类可被"锁定": 「图片素材库」只显示图片、「视频素材库」只显示视频。
  // 锁定时弹窗里连分类切换按钮都隐藏, 保证"按钮名字写了哪一类, 弹窗里就只有哪一类"。
  var mediaKindLocked = false;
  var mediaTarget = '';       // mode=input: 目标输入框选择器
  var mediaPreview = '';      // mode=input: 可选, 目标预览图选择器
  // 素材目录清单由模板下发(真值在 core/storage.js), 手工填写时用它判断"写全了没有"
  var mediaPrefixes = String((mediaModal && mediaModal.getAttribute('data-media-prefixes')) || 'image/,video/,news_uploads/')
    .split(',').map(function (p) { return p.trim(); }).filter(Boolean);
  //: 服务端单层列举上限(与 lib/mediaBrowse.js 的 LEVEL_MAX 同值): 超了要在状态行里说清楚, 不能装作列全了
  var MEDIA_LEVEL_MAX = 1000;
  var mediaBase = '';         // 媒体公开域(服务端下发): 预览图地址按它拼, 不拼站点根路径
  var mediaPrefix = '';       // 当前所在目录(带尾斜杠; 空串 = 存储桶最外层)
  var mediaFolders = [];      // 当前这一层的子目录
  var mediaPage = 0;          // 已加载到第几页
  var mediaTotalPages = 1;
  var mediaTotal = 0;         // 本层命中的素材总数
  var mediaAccept = [];       // 本层可列出的扩展名
  var mediaLoading = false;

  /** 关掉素材库弹窗(页面的插入函数也用得上, 见文件末尾的 window.MediaLibrary)。 */
  function closeModal() {
    if (mediaModal && window.bootstrap && window.bootstrap.Modal) {
      var inst = window.bootstrap.Modal.getInstance(mediaModal);
      if (inst) { inst.hide(); }
    }
  }

  function mediaSetHint(text, isError) {
    if (!mediaHintEl) { return; }
    mediaHintEl.className = isError ? 'small text-danger mb-2' : 'small text-muted mb-2';
    mediaHintEl.textContent = text || '';
  }

  /** 对象的父目录(带尾斜杠; 根目录返回空串): 先剥尾斜杠, 否则 'image/' 会算出它自己。 */
  function mediaParentOf(key) {
    var body = String(key || '').replace(/\/+$/, '');
    var at = body.lastIndexOf('/');
    return at < 0 ? '' : body.slice(0, at + 1);
  }

  // 面包屑/目录按钮一律用 DOM 建节点(不用字符串拼 HTML): 目录名来自磁盘, 可能含引号与中文, 交给 textContent 最稳
  function mediaCrumb(label, prefix, current) {
    if (current) {
      var span = document.createElement('span');
      span.className = 'fw-semibold';
      span.textContent = label;
      return span;
    }
    var link = document.createElement('a');
    link.href = '#';
    link.setAttribute('data-media-dir', prefix);
    link.textContent = label;
    return link;
  }

  function mediaSep() {
    var span = document.createElement('span');
    span.className = 'text-muted mx-1';
    span.textContent = '/';
    return span;
  }

  function mediaDirButton(label, prefix, icon) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-secondary';
    button.setAttribute('data-media-dir', prefix);
    button.innerHTML = '<i class="bi ' + icon + '" aria-hidden="true"></i> ';
    button.appendChild(document.createTextNode(label));
    return button;
  }

  /** 面包屑与子目录按钮: 跟着当前目录换一层, 点任意一段回该层, 「上一级」退一层。 */
  function mediaRenderNav() {
    if (mediaCrumbsEl) {
      mediaCrumbsEl.innerHTML = '';
      var pieces = String(mediaPrefix || '').split('/').filter(Boolean);
      mediaCrumbsEl.appendChild(mediaCrumb('存储桶', '', pieces.length === 0));
      var walked = '';
      pieces.forEach(function (piece, index) {
        walked += piece + '/';
        mediaCrumbsEl.appendChild(mediaSep());
        mediaCrumbsEl.appendChild(mediaCrumb(piece + '/', walked, index === pieces.length - 1));
      });
    }
    if (!mediaDirsEl) { return; }
    mediaDirsEl.innerHTML = '';
    // 面包屑也能回上一层, 但目录一多就要找半天 —— 单独给一个按钮
    if (mediaPrefix) {
      mediaDirsEl.appendChild(mediaDirButton('上一级', mediaParentOf(mediaPrefix), 'bi-arrow-up'));
    }
    mediaFolders.forEach(function (folder) {
      mediaDirsEl.appendChild(mediaDirButton(folder.name + '/', folder.key, 'bi-folder2-open'));
    });
    if (!mediaDirsEl.children.length) {
      var none = document.createElement('span');
      none.className = 'text-muted small';
      none.textContent = '这个目录下没有子目录';
      mediaDirsEl.appendChild(none);
    }
  }

  /** 触底提示条: 还有下一页就提示可继续滚, 到底了就报已加载多少。 */
  function mediaSyncMore() {
    if (!mediaMoreTextEl) { return; }
    if (mediaPage < mediaTotalPages) {
      mediaMoreTextEl.innerHTML = '<i class="bi bi-arrow-down-circle" aria-hidden="true"></i> 滚动到底自动加载更多';
      return;
    }
    mediaMoreTextEl.textContent = mediaTotal ? '— 已全部加载 ' + mediaTotal + ' 个素材 —' : '';
  }

  /** 空态行: 只在第一页没有行时用(服务端给的行 HTML 里不会有它)。 */
  function mediaEmptyRow() {
    return '<tr><td colspan="6" class="text-muted py-3">这个目录下没有匹配的'
      + (mediaKind === 'image' ? '图片' : '视频')
      + '素材：换个关键词、进上面的子目录, 或用下面的「手工填写路径」。</td></tr>';
  }

  /** 状态行: 当前位置 + 本层命中数 + 单层上限提示(按当前分类措辞)。 */
  function mediaHintFor(data) {
    var label = mediaKind === 'image' ? '图片' : '视频';
    var parts = [
      '当前位置：' + (mediaPrefix ? '/' + mediaPrefix : '存储桶根目录'),
      '本层 ' + (Number(data.levelCount) || 0) + ' 个对象、其中' + label + ' ' + mediaTotal + ' 个',
      '可列出：' + (mediaAccept.join(' / ') || '—')
    ];
    if (data.truncated) {
      parts.push('这一层超过单层上限 ' + MEDIA_LEVEL_MAX + ' 个, 只列了前一批 —— 用关键词或进子目录缩小范围');
    }
    mediaSetHint(parts.join(' · '));
  }

  /**
   * 拉取当前目录的某一页。
   * @param {number}  page   页码(从 1 起)
   * @param {boolean} append true = 把返回的行追加在已有行后面(触底加载); false = 清空重画
   *                         (进目录、换分类、改关键词、点刷新都走 false)
   */
  function mediaFetch(page, append) {
    if (!mediaListEl || mediaLoading) { return; }
    var q = mediaQueryEl && mediaQueryEl.value ? mediaQueryEl.value.trim() : '';
    // 记下这次请求是为哪一类、哪个目录发的: 响应回来时用它判断是否已经过期
    var reqKind = mediaKind;
    var reqPrefix = mediaPrefix;
    mediaLoading = true;
    if (!append) {
      mediaListEl.innerHTML = '';
      mediaSetHint('正在读取素材目录…');
    }
    var url = '/admin/media_library?kind=' + encodeURIComponent(reqKind)
      + '&prefix=' + encodeURIComponent(reqPrefix)
      + '&page=' + encodeURIComponent(page)
      + (q ? '&q=' + encodeURIComponent(q) : '');
    // X-Requested-With: 与后台其它 AJAX 同口径 —— 会话过期时后端回 JSON, 而不是 302 到登录页
    fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' })
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        mediaLoading = false;
        if (!data || data.success !== true) { throw new Error((data && data.message) || '读取失败'); }
        // 关键: 等待期间分类或目录若已改变, 这次响应只丢不画 —— 否则会把上一个目录的行画到新目录下面
        if (reqKind !== mediaKind || reqPrefix !== mediaPrefix) { return; }
        mediaBase = data.base || '';
        mediaAccept = data.accept || [];
        mediaFolders = data.folders || [];
        mediaPrefix = data.prefix || '';
        mediaPage = Number(data.page) || 1;
        mediaTotalPages = Number(data.totalPages) || 1;
        mediaTotal = Number(data.total) || 0;
        if (append) {
          if (data.rows) { mediaListEl.insertAdjacentHTML('beforeend', data.rows); }
        } else {
          mediaListEl.innerHTML = data.rows || mediaEmptyRow();
        }
        mediaRenderNav();
        mediaHintFor(data);
        mediaSyncMore();
      })
      .catch(function (err) {
        mediaLoading = false;
        if (reqKind !== mediaKind || reqPrefix !== mediaPrefix) { return; }   // 过期请求的失败不该影响当前目录
        if (!append) { mediaListEl.innerHTML = ''; }
        mediaSetHint('读取素材失败：' + ((err && err.message) || '网络异常')
          + '（不影响使用 —— 可直接用下面的「手工填写路径」）', true);
        mediaSyncMore();
      });
  }

  /** 进目录: 目录变了就从第 1 页重画(已经追加的行属于上一个目录)。 */
  function mediaEnterDir(prefix) {
    mediaPrefix = String(prefix || '');
    mediaFolders = [];
    mediaFetch(1, false);
    if (window.a11yAnnounce) { window.a11yAnnounce('进入素材目录 ' + (mediaPrefix || '存储桶')); }
  }

  /** 触底加载: 哨兵在滚动容器里, 滚到它附近就取下一页(与治理页同一个思路, root 换成弹窗的滚动区)。 */
  function mediaInitMore() {
    if (!mediaMoreEl || !mediaScrollEl || !('IntersectionObserver' in window)) { return; }
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) { return; }
      if (mediaLoading || mediaPage >= mediaTotalPages) { return; }
      mediaFetch(mediaPage + 1, true);
    }, { root: mediaScrollEl, rootMargin: '0px 0px 120px 0px' });
    io.observe(mediaMoreEl);
  }

  /**
   * 切换分类(图片/视频): 同一份列表结构, 只换请求参数。
   * fromOpen=true 表示"这是打开弹窗时由按钮指定的分类", 锁定时只有它能生效;
   * 用户点分类按钮(不带 fromOpen)在锁定态下直接忽略。
   */
  function mediaSetKind(kind, fromOpen) {
    if (mediaKindLocked && !fromOpen && kind !== mediaKind) { return; }
    mediaKind = kind === 'video' ? 'video' : 'image';
    Array.prototype.forEach.call(mediaKindBtns, function (b) {
      b.classList.toggle('active', b.getAttribute('data-media-kind-btn') === mediaKind);
    });
    // 锁定时隐藏整块分类切换 —— UI 上就不给切, 与"只显示某一类素材"的口径一致
    if (mediaKindGroupEl) { mediaKindGroupEl.classList.toggle('d-none', mediaKindLocked); }
    if (mediaManualEl) {
      // 手工填写框的示例跟随分类与目录口径(避免误导: 图片分类下的示例却是 .mp4)
      mediaManualEl.placeholder = mediaKind === 'image' ? 'image/cover_xxx.png' : 'video/video_xxx.mp4';
    }
    // 换分类等于从头看: 回存储桶根目录、清掉关键词, 免得"上一个分类的目录位置"带进来
    mediaPrefix = '';
    mediaFolders = [];
    if (mediaQueryEl) { mediaQueryEl.value = ''; }
    mediaFetch(1, false);
  }

  function mediaApply(item) {
    if (!item || !item.path) { return; }
    if (mediaMode === 'input') {
      var input = mediaTarget ? document.querySelector(mediaTarget) : null;
      if (!input) {
        mediaSetHint('插入失败：页面上找不到要填入的字段（' + (mediaTarget || '未指定目标') + '）。', true);
        return;
      }
      input.value = item.path;          // 库内相对记录值, 与「本地上传」的结果完全同口径
      input.classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
      // 封面这类字段还带预览图: 一并刷新, 否则会出现"地址换了、预览还是旧的"
      var preview = mediaPreview ? document.querySelector(mediaPreview) : null;
      if (preview) {
        // 预览走媒体公开域: 站点根路径只对 Worker 直出的那几个前缀有效, 别的对象会 404
        preview.src = mediaBase ? mediaBase + '/' + item.path : '/' + item.path;
        preview.classList.remove('d-none');
      }
    } else {
      // editor 模式: 交给**页面**提供的插入函数(编辑页实现为 restoreSelection + insertNode)。
      // 共享脚本不碰编辑器 —— 有编辑器就插节点、没编辑器就报错, 由页面决定。
      var insertToEditor = window.MediaInsertFromLibrary;
      if (typeof insertToEditor !== 'function') {
        mediaSetHint('这个页面没有可插入的编辑器（未提供 MediaInsertFromLibrary）。', true);
        return;
      }
      insertToEditor(item.path, item.kind === 'video' ? 'video' : 'image');
      return;   // 关弹窗与播报由页面的插入函数负责(只有它知道这次插入的结果)
    }
    closeModal();
    if (window.a11yAnnounce) {
      window.a11yAnnounce((item.kind === 'video' ? '视频' : '图片') + '地址已填入');
    }
  }

  // 手工路径归一化: 去开头斜杠与反斜杠 → 没写目录就按当前分类补(image/ 或 video/) → 拒绝 ..
  function mediaNormalizeManual(value) {
    var v = (value || '').trim().replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!v || v.indexOf('..') >= 0) { return ''; }
    var full = false;
    for (var i = 0; i < mediaPrefixes.length; i++) {
      if (v.indexOf(mediaPrefixes[i]) === 0) { full = true; break; }
    }
    if (!full) { v = (mediaKind === 'video' ? 'video/' : 'image/') + v; }
    return v;
  }

  // 手工填写时按扩展名判断是图片还是视频 —— 不该要求用户为一个路径再选一次分类
  var MEDIA_VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ts', 'm3u8',
                          '3gp', 'avi', 'flv', 'wmv', 'f4v'];
  function mediaKindOfPath(path) {
    var m = /\.([a-z0-9]+)$/i.exec(path || '');
    var ext = m ? m[1].toLowerCase() : '';
    return MEDIA_VIDEO_EXTS.indexOf(ext) >= 0 ? 'video' : 'image';
  }

  (function bindMediaPicker() {
    if (!mediaModal) { return; }
    // 打开弹窗: 从**触发它的按钮**上取本次行为(三个入口共用本弹窗)
    mediaModal.addEventListener('show.bs.modal', function (e) {
      var btn = e.relatedTarget;
      function attr(name) { return (btn && btn.getAttribute) ? (btn.getAttribute(name) || '') : ''; }
      mediaMode = attr('data-media-mode') === 'input' ? 'input' : 'editor';
      mediaTarget = attr('data-media-target');
      mediaPreview = attr('data-media-preview');
      // 「图片素材库」/「视频素材库」这类按钮带 data-media-lock-kind:
      // 打开后只显示对应类型素材(隐藏分类切换); 标题也写明是哪一类, 免得用户以为还能切。
      mediaKindLocked = attr('data-media-lock-kind') === '1';
      mediaSetKind(attr('data-media-kind') || 'image', true);
      if (mediaTitleEl) {
        mediaTitleEl.textContent = mediaKindLocked
          ? (mediaKind === 'video' ? '从视频素材库选择' : '从图片素材库选择')
          : '从素材库选择';
      }
    });
    // 行与目录按钮都在弹窗里: 统一在弹窗上委托一次, 不逐个绑(行是触底加载追加进来的)
    mediaModal.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) { return; }
      var dirEl = target.closest('[data-media-dir]');
      if (dirEl) {
        event.preventDefault();     // 面包屑是 <a href="#">
        mediaEnterDir(dirEl.getAttribute('data-media-dir') || '');
        return;
      }
      var chooseEl = target.closest('[data-media-choose]');
      if (!chooseEl) { return; }
      var row = chooseEl.closest('[data-media-row]');
      if (!row) { return; }
      mediaApply({
        path: row.getAttribute('data-media-pick-key') || '',
        kind: row.getAttribute('data-media-pick-kind') || mediaKind
      });
    });
    Array.prototype.forEach.call(mediaKindBtns, function (b) {
      b.addEventListener('click', function () {
        if (mediaKindLocked) { return; }   // 锁定时不给切(该按钮组此时也已隐藏)
        mediaSetKind(b.getAttribute('data-media-kind-btn'));
      });
    });
    // 为什么显式写 false: 直接写 addEventListener('click', mediaFetch) 会把事件对象当 append 传进去
    // (碰巧是真值), 于是刷新变成"往旧列表后面再追加一页"。
    var reloadBtn = document.getElementById('mediaLibraryReload');
    if (reloadBtn) { reloadBtn.addEventListener('click', function () { mediaFetch(1, false); }); }
    if (mediaQueryEl) {
      mediaQueryEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); mediaFetch(1, false); }
      });
      mediaQueryEl.addEventListener('search', function () { mediaFetch(1, false); });  // 「×」清空也重新拉
    }
    var manualBtn = document.getElementById('mediaLibraryManualInsert');
    if (manualBtn) {
      manualBtn.addEventListener('click', function () {
        var rel = mediaNormalizeManual(mediaManualEl ? mediaManualEl.value : '');
        if (!rel) {
          mediaSetHint('路径不合法：应为 ' + mediaPrefixes.join(' 或 ') + ' 下的相对路径，且不能包含 ..', true);
          return;
        }
        mediaApply({ path: rel, kind: mediaKindOfPath(rel) });
      });
    }
    if (mediaManualEl && manualBtn) {
      mediaManualEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); manualBtn.click(); }
      });
    }
    mediaInitMore();
  })();

  // 给页面用的小 API(编辑页"插入失败"时把原因写回弹窗、插完关弹窗)
  window.MediaLibrary = {
    hint: mediaSetHint,
    close: closeModal,
    kindOfPath: mediaKindOfPath
  };
})();
