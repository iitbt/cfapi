// 从 pages/news.js 的内联模板字符串搬来的(2.5.0): 真文件才有语法检查,
// 模板字符串里反斜杠会被求值吃掉、反引号会直接截断脚本(2026-10-10 两次教训)。
  (function () {
    var form = document.getElementById('batchForm');
    if (!form) return;
    // 文案里的单位: 笔记页不写 data-unit(默认"笔记"), 公告页写 data-unit="公告" —— 同一份脚本两页共用(2.6.1)
    var unit = form.getAttribute('data-unit') || '笔记';
    var actionField = document.getElementById('batchAction');
    var all = document.getElementById('rowCheckAll');
    if (all) {
      all.addEventListener('change', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rowCheck'), function (box) { box.checked = all.checked; });
      });
    }
    function selected() {
      return Array.prototype.filter.call(document.querySelectorAll('.rowCheck'), function (box) { return box.checked; });
    }
    // 二次确认与数量提示都写在这里(不是表单的 onsubmit): 下面用 form.submit() 提交, 那条路径不触发 onsubmit
    Array.prototype.forEach.call(form.querySelectorAll('[data-batch]'), function (btn) {
      btn.addEventListener('click', function () {
        var boxes = selected();
        if (!boxes.length) { alert('请先勾选要操作的' + unit); return; }
        var action = btn.getAttribute('data-batch');
        if (action === 'delete' && !confirm('确定删除选中的 ' + boxes.length + ' 条' + unit + '？此操作不可恢复。')) return;
        document.getElementById('batchIds').value = boxes.map(function (box) { return box.value; }).join(',');
        if (actionField) actionField.value = action;
        form.submit();
      });
    });
  })();
