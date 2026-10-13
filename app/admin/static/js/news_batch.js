// 从 pages/news.js 的内联模板字符串搬来的(2.5.0): 真文件才有语法检查,
// 模板字符串里反斜杠会被求值吃掉、反引号会直接截断脚本(2026-10-10 两次教训)。
  (function () {
    var form = document.getElementById('batchForm');
    if (!form) return;
    var all = document.getElementById('rowCheckAll');
    if (all) {
      all.addEventListener('change', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rowCheck'), function (box) { box.checked = all.checked; });
      });
    }
    function selected() {
      return Array.prototype.filter.call(document.querySelectorAll('.rowCheck'), function (box) { return box.checked; });
    }
    Array.prototype.forEach.call(form.querySelectorAll('[data-batch]'), function (btn) {
      btn.addEventListener('click', function () {
        var boxes = selected();
        if (!boxes.length) { alert('请先勾选要操作的笔记'); return; }
        var action = btn.getAttribute('data-batch');
        if (action === 'delete' && !confirm('确定删除选中的 ' + boxes.length + ' 条笔记？')) return;
        document.getElementById('batchIds').value = boxes.map(function (box) { return box.value; }).join(',');
        document.getElementById('batchAction').value = action;
        form.submit();
      });
    });
  })();
