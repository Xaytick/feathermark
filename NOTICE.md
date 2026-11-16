# NOTICE

FeatherMark 以 GPL-3.0 发布。

## 来源与移植说明

本项目在设计和技术选型上参考了开源项目 **TizuMark**
（<https://github.com/tizuio/TizuMark-Markdown-Editor>，作者 tizuio，GPL-3.0）。

以下文件/模块直接移植或改写自该项目，遵循 GPL-3.0 条款：

| 本项目文件 | 来源 | 说明 |
| --- | --- | --- |
| `src/unified-renderer.js` | TizuMark `src/unified-renderer.js` | unified/remark 渲染管线：提示块、脚注、定义列表、数学守卫、Wikilink、HTML 净化等 |
| `src/md2/*` | TizuMark `src/md2/*` | 自定义表格方言的解析与渲染（保留其原始 LICENSE） |
| `src-tauri/src/lib.rs` 中的文件命令 | TizuMark `src-tauri/src/lib.rs` | 编码探测（UTF-8/GB18030）、`safe_write_target` 路径拦截、目录列表、通知式目录监听、图片 MD5 去重入库、系统字体枚举、全文搜索等 |

其余部分（界面、编辑器封装、标签页、文件树、导出、设置、主题体系等）为独立实现，
但沿用了 TizuMark 的架构决策：IPC 收敛到单一模块、前端保持「经典 script + 全局」形态、
渲染器作为单一真相源经 esbuild 打包。

## 第三方组件

| 组件 | 许可 |
| --- | --- |
| Tauri / Wry | Apache-2.0 / MIT |
| CodeMirror 5 | MIT |
| unified、remark、rehype 系列 | MIT |
| KaTeX | MIT |
| Mermaid | MIT |
| highlight.js | BSD-3-Clause |
| html2canvas | MIT |
| jsPDF | MIT |

GPL-3.0 全文见 `LICENSE`。
