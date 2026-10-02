(function () {
  const pad = value => String(value).padStart(2, '0');
  function toLocalInput(timestamp) {
    if (!Number(timestamp)) return '';
    const date = new Date(Number(timestamp));
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function rowHtml(window = {}) {
    return `<div class="schedule-window-row"><label class="form-field"><span>开始时间</span><input class="admin-input schedule-start" type="datetime-local" value="${toLocalInput(window.start)}"></label><span class="schedule-window-arrow">至</span><label class="form-field"><span>结束时间</span><input class="admin-input schedule-end" type="datetime-local" value="${toLocalInput(window.end)}"></label><button type="button" class="remove-test-case schedule-remove" title="删除时间段">×</button></div>`;
  }
  function add(prefix, window = {}) { document.getElementById(`${prefix}-schedule-windows`).insertAdjacentHTML('beforeend', rowHtml(window)); }
  function set(prefix, availability = {}) {
    const enabled = availability.enabled === true;
    document.getElementById(`${prefix}-schedule-enabled`).checked = enabled;
    document.getElementById(`${prefix}-schedule-settings`).hidden = !enabled;
    document.getElementById(`${prefix}-after-end-view`).value = availability.afterEndView || 'none';
    const list = document.getElementById(`${prefix}-schedule-windows`);
    list.innerHTML = '';
    (availability.windows?.length ? availability.windows : [{}]).forEach(window => add(prefix, window));
  }
  function get(prefix) {
    const enabled = document.getElementById(`${prefix}-schedule-enabled`).checked;
    const windows = [...document.querySelectorAll(`#${prefix}-schedule-windows .schedule-window-row`)].map(row => ({ start: new Date(row.querySelector('.schedule-start').value).getTime(), end: new Date(row.querySelector('.schedule-end').value).getTime() })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
    return { enabled, windows: enabled ? windows : [], afterEndView: document.getElementById(`${prefix}-after-end-view`).value };
  }
  function bind(prefix) {
    document.getElementById(`${prefix}-schedule-enabled`).addEventListener('change', event => {
      document.getElementById(`${prefix}-schedule-settings`).hidden = !event.target.checked;
      if (event.target.checked && !document.querySelector(`#${prefix}-schedule-windows .schedule-window-row`)) add(prefix);
    });
    document.getElementById(`add-${prefix}-schedule-window`).addEventListener('click', () => add(prefix));
    document.getElementById(`${prefix}-schedule-windows`).addEventListener('click', event => {
      const button = event.target.closest('.schedule-remove');
      if (button) button.closest('.schedule-window-row').remove();
    });
  }
  window.AdminSchedule = { bind, set, get };
}());
