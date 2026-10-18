# 测试与发布验证

开发和打包需要 Node.js 24；安装发布 ZIP 使用扩展不需要 Node.js。以下命令均在仓库根目录执行。

## 静态检查与后台测试

```sh
npm run check
npm test
```

这两项不需要安装 npm 依赖。静态检查验证 JavaScript 语法、Manifest V3、版本一致性、权限、资源路径大小写和 PNG 图标尺寸。

后台测试在隔离 VM 中执行真实 `background.js`，仅用内存模拟 Chrome API，不访问正在使用的浏览器。覆盖：

- 29 个并发添加请求、24 个收藏上限、排序删除和持久化。
- 模式持久化、非法模式输入、旧版收藏兼容与模式隔离。
- 57 个标签全量返回，同网址不同物理标签保持独立。
- 跨窗口激活、标签导航和替换、关闭恢复、会话重启后的 tab ID 复用保护。
- 存储故障恢复、本地 PNG 图标校验、缓存复用，以及图标读取不阻塞切换。

## 真实浏览器集成测试

安装可选开发工具和测试浏览器：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

测试脚本默认使用本项目安装的 Playwright 和其 Chromium。可用 `TAB_ORBIT_CHROME` 指定支持加载解压扩展的 Chrome for Testing 可执行文件，`TAB_ORBIT_PLAYWRIGHT` 或脚本的第一个参数指定其他 Playwright 包，`TAB_ORBIT_HEADLESS=false` 显示测试窗口。测试脚本不会自行安装工具或下载浏览器。

每次使用新建的独立浏览器 profile 和本机 HTTP 演示页面，完整加载 MV3 扩展，通过真实鼠标键盘产生 `isTrusted` 输入。测试不连接用户日常浏览器，不读取其中的标签。

集成范围包括普通右键、Ctrl + 右键、悬停放大、松开切换、圆心与 Esc 取消、边缘原地点击、输入焦点恢复、原网页样式和事件保持、搜索排序移除、跨窗口切换、关闭恢复、本地图标、严格 CSP 和 closed Shadow DOM。1.1 还覆盖：

- 弹窗切换自定义/所有标签模式，未收藏时也可自动显示所有标签。
- 24 个收藏以内 8 外 16 双圈显示；完整窗口、640 × 720 窄窗口及边缘位置逐个真实悬停。
- 内外圈分别悬停并松开右键激活具体标签。
- 超过 24 个标签时滚轮翻页，尾页可达；翻页后原地或微移松手安全取消。
- 手势中修改模式取消当前选择；切回自定义时收藏及顺序完整保留。

CDP 调试接口只用于读取 closed Shadow DOM 的位置和状态，交互仍由真实鼠标键盘完成。每次测试的报告、截图和 profile 写入 `test-artifacts/`，该目录被 Git 忽略且不会进入发布包。

弹窗作为扩展页面加载；原生工具栏弹出气泡的焦点关闭、系统菜单及窗口外释放鼠标仍需人工验收。Chrome 设置页、新标签页和应用商店等页面的注入限制见 [README](README.md)。

## 发行 ZIP

```sh
npm run package
```

仅用 Node.js 内置模块生成 `release/tab-orbit-v版本号.zip` 及 `.zip.sha256` 校验文件。包内 `manifest.json` 位于根目录，仅包含明确清单中的运行文件、图标和 `INSTALL.txt`，排除源码文档、测试、依赖和 profile。

打包固定条目顺序、ZIP 时间戳和文本换行。同一输入重复执行得到相同字节；若同名产物已存在但内容不同，脚本拒绝覆盖，便于发布前检查版本和文件变化。`release/` 已加入 Git 忽略。

可在 Windows、macOS 或 Linux 本地依次运行 `npm run check`、`npm test` 和 `npm run package`，完成静态检查、后台测试与打包验证；再次运行打包命令可检查产物一致性。这些脚本不会创建 GitHub Release 或自动上传文件。公开仓库不提供 GitHub Actions 工作流。

## 已验证结果

2026-10-18，v1.1.0 后台测试 **31 / 31 通过**；Chrome for Testing **155.0.8059.39** 完整扩展集成检查 **19 / 19 通过**，未捕获的 JavaScript 错误为 0。双圈、窄窗口、边缘定位和管理弹窗截图已经检查，无卡片重叠。
