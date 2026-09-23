# 机创 OJ 平台 - 零后端在线评测系统

## 项目概述

这是一个完全免费、无需服务器的在线代码评测平台，支持 C/C++/Python/Java/JavaScript/Go/Rust 等多种编程语言。

## 核心架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  前端 (SPA)  │────▶│ Judge0 CE API│     │ GitHub Repo     │
│  GitHub Pages│     │ (代码执行)    │     │ (数据存储)       │
└─────────────┘     └──────────────┘     └────────┬────────┘
       │                                          │
       ▼                                          ▼
┌─────────────────┐                    ┌──────────────────┐
│ Cloudflare Worker│                    │ GitHub Actions   │
│ (安全代理)       │                    │ (排名生成)        │
└─────────────────┘                    └──────────────────┘
```

## 技术栈

- **代码执行**: [Judge0 CE](https://github.com/judge0/judge0) - 开源代码执行引擎
- **代码编辑器**: Monaco Editor (VS Code 同款)
- **数据存储**: GitHub Contents API
- **排名系统**: GitHub Actions + GitHub Pages
- **安全代理**: Cloudflare Workers (可选)
- **前端**: 原生 HTML/CSS/JS，零依赖

## 快速开始

### 1. 本地运行

```bash
# 使用任意静态文件服务器
# Python
python -m http.server 8080

# Node.js
npx serve .
```

打开 `http://localhost:8080` 即可使用。

### 2. 部署到 GitHub Pages

1. 将项目推送到 GitHub 仓库
2. 进入仓库 Settings → Pages
3. Source 选择 `main` 分支，目录选择 `/ (root)`
4. 保存后等待部署完成

### 3. 配置提交功能（可选）

#### 方式 A: Cloudflare Worker（推荐）

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/) 创建 Worker
2. 将 `cloudflare/worker.js` 的内容粘贴到 Worker 编辑器
3. 在 Worker Settings → Variables and Secrets 中添加：
   - `GITHUB_TOKEN`: GitHub Personal Access Token (需要 repo 权限)
   - `GITHUB_REPO`: 你的仓库名（格式：`username/repo`）
   - `JUDGE0_API_URL`: Judge0 地址（可选，默认 `https://ce.judge0.com`）
4. 更新 `js/config.js` 中的 `WORKER_URL`

如果使用仓库中的 `wrangler.toml` 部署，可在 `cloudflare/` 目录执行：

```bash
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

公共 Judge0 CE 当前不需要 API Key，但属于共享服务，可能限流且没有可用性保证。正式或高频使用时建议自托管 Judge0，并将 `JUDGE0_API_URL` 指向自己的实例。

#### 方式 B: 直接 GitHub Token（仅用于开发测试）

⚠️ 不推荐在生产环境使用，Token 会暴露在前端代码中。

在 `js/config.js` 中设置 `GITHUB_TOKEN` 和 `GITHUB_REPO`。

## 添加题目

在 `problems/` 目录下创建 JSON 文件：

```json
{
  "id": "P004",
  "title": "题目名称",
  "difficulty": "easy",
  "description": "题目描述（支持 Markdown）",
  "inputFormat": "输入格式说明",
  "outputFormat": "输出格式说明",
  "constraints": "数据范围限制",
  "sampleInput": "示例输入",
  "sampleOutput": "示例输出",
  "testCases": [
    { "input": "测试输入", "expectedOutput": "期望输出" }
  ],
  "hints": ["提示1", "提示2"]
}
```

然后在 `problems/index.json` 中添加题目列表项。

## 目录结构

```
online-oj/
├── index.html              # 入口页面
├── css/
│   └── style.css           # 样式（暗色主题）
├── js/
│   ├── config.js           # 全局配置
│   ├── languages.js        # 编程语言定义
│   ├── editor.js           # Monaco 编辑器封装
│   ├── runner.js           # Judge0 API 代码执行
│   ├── judge.js            # 判题逻辑
│   ├── github.js           # GitHub API 交互
│   ├── views.js            # 视图路由
│   └── app.js              # 主控制器
├── problems/               # 题目数据
│   ├── index.json          # 题目列表
│   └── p001-aplusb.json    # 题目详情
├── cloudflare/
│   └── worker.js           # CF Worker 代理
├── .github/
│   └── workflows/
│       └── ranking.yml     # 排名自动生成
├── scripts/
│   └── rank-generator.js   # 排名算法
├── submissions/            # 提交记录（由 Actions 写入）
│   └── .gitkeep
└── dist/                   # 排名数据（由 Actions 生成）
    └── .gitkeep
```

## 功能特性

✅ **多语言支持**: C/C++/Python/Java/JavaScript/Go/Rust  
✅ **在线判题**: 实时编译运行，逐条测试用例验证  
✅ **代码编辑器**: Monaco Editor，支持语法高亮、自动补全  
✅ **排行榜**: GitHub Actions 自动生成，实时更新  
✅ **零成本**: 完全免费，无需服务器  
✅ **开源**: 代码全部开源可控  
✅ **安全**: 可选 Cloudflare Worker 代理，保护 Token 安全  

## 许可证

MIT License
