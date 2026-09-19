/**
 * 视图管理模块
 * 处理页面路由和视图切换
 */
class ViewManager {
  constructor() {
    this.currentView = 'problems';
    this.views = ['problems', 'solve', 'submissions'];
  }

  show(viewName) {
    if (!this.views.includes(viewName)) {
      console.warn(`未知视图: ${viewName}`);
      return;
    }

    this.currentView = viewName;

    // 隐藏所有视图
    this.views.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.style.display = 'none';
    });

    // 显示目标视图
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.style.display = 'block';

    // 更新导航高亮
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.view === viewName);
    });
  }

  init() {
    // 绑定导航事件
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const view = e.target.dataset.view;
        if (view) this.show(view);
      });
    });

    // 默认显示题目列表
    this.show('problems');
  }
}
