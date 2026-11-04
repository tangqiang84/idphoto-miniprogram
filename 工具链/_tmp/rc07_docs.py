"""RC-07交付文档同步；追加当前结论，不删除早期阶段留痕。"""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
marker='## RC-07迁移交付（2026-11-04）'
sections={
 '项目资产与工具手册.md':'''| 资产 | 用途 | 验证边界 |
| --- | --- | --- |
| `src/components/PhotoTool/index.tsx`（小程序目录） | T2/T3/T5共享当前步骤页面；薄路由注入tool | T1页面保留，复用同一会话/处理 |
| `src/components/BackgroundControl/index.tsx` | T2 HEX/RGB/渐变/透明控件 | 越界拒绝，实际预览/成品由共享处理生成 |
| `processingSession`、`t1Workflow`、`useT1Workflow`、`t1Processing` | 按工具配置参数/流程/平台处理，T5纯变换 | 历史函数名兼容T1 |
| `工具链/tests/tool_migration.test.js` | 5项实际页面/处理测试，含T4/T6隔离 | SDK/质量算法替身，不证明真机质量 |
| `工具链/tests/background_control.test.js` | 实际控件正反输入、切换及CSS方向 | 非像素SDK实测 |
| `工具链/smoke_rc07.js` | `--app <禁云副本> --port <端口> --tool T1/T2/T3/T5 --out <新目录>` | 真实本地微信SDK/文件；T2生成同色JPEG和渐变样例 |
| `工具链/_tmp/rc07_migrate.py`、`rc07_pages.py`、`rc07_registry.py`、`rc07_finalize.py` | 本轮源码迁移/生成及证据登记脚本留存 | 不应直接重复运行；原页面归档在本轮记录目录 |
| `工具链/_tmp/rc07_ui_script.py`、`rc07_sdk_run.py` | SDK脚本派生及四工具串行调度，调度需--app/--port/--out | 输出目录独占创建 |
| `工具链/_tmp/rc07_files.py` | 现有运行时Pillow独立读格式/尺寸/Alpha/颜色 | 固定样本，不等于全图集质量 |
| `工具链/_tmp/rc07_audit.py` | 应用/构建/依赖/SDK/文档哈希核验 | 独占新报告 |

当前core382、工具50、Lint162文件；基线v1.8，76需求/97协议与局部用例/21局部实现。页面探针T1/T2/T3/T5当前均PASS（确认前区间），旧FAIL仍保留。新流程实际命令优先于旧脚本固定路径/旧自动处理说明。''',
 '技术架构说明.md':'''T2/T3/T5页面已成为薄路由，复用PhotoTool和按工具配置的会话/步骤/平台处理。T2底色在最终照片坐标合成，T3换装与当前结果自检必需，T5平台分支直接裁剪缩放/压缩且不进入人脸管线。T4/T6继续隔离。API、失效规则与验证边界见[迁移说明](docs/RC-07迁移说明.md)。''',
 '小程序开发指南.md':'''T2/T3/T5不再修改各页面的独立run链路；入口注入tool，业务差异放共享策略和处理适配。修改共享节点运行core、工具tests、类型/Lint、隔离构建及关联SDK；T5不得经prepareWorkCanvas触发人脸度量。当前382项core、50项工具测试；详细命令见资产手册本轮小节。''',
 '产品功能清单.md':'''T2规格必选且无换装，支持HEX/RGB/渐变/透明素材；T3九规格且换装/自检不可跳过；T5保留标准/自定义像素与KB，纯变换逐步确认。T2素材风险不代表证件合规，其他硬检查保留。当前迁移交付不代表真实模型/模板质量或全规格/真机完成。''',
 '页面原型设计.md':'''T2/T3/T5现已接共享独立步骤，与T1按工具配置区分；原型补RGB校验、渐变两端/角度交互和素材风险提示。T2去除保持原图分支，T3无换装跳过，T5裁剪后进入档位。早期实现表与“渐变暂缓/未迁移”文字仅作历史记录，最新以[迁移说明](docs/RC-07迁移说明.md)为准。''',
 '测试用例与验收清单.md':'''本轮core382、工具50；新增真实页面/处理链、颜色控件、T4只读/T6独立输出及反向渐变/参数边界断言。四工具当前裁剪确认前探针PASS，控制层全链正例及禁止动作分别验证。SDK串行验证T1/T2/T3/T5固定授权样本；T2同色JPEG哈希等价、透明PNG及渐变实际文件独立读取。SDK自检勾选只算流程验证。''',
 '开发任务台账.md':'''RC-07已落实共享页面/处理迁移、T2颜色素材与规格必选、T3换装双自检、T5纯变换和T4/T6隔离控制回归。最终状态以[整改任务](docs/整改开发任务.md)及[验收报告](docs/验证记录/RC-07-implementation/验收报告.md)为准；先前未完成/FAIL是修复前记录，不删除。''',
 '问题台账.md':'''迁移修复：选图即处理、T2保持原图、页面参数分散。新增回归还发现并修复：非法RGB拒绝后仍处理旧底色、反向渐变缺负轴偏移、工作余量截去渐变端点、CSS角度方向反转、T3改档位返回预审误受旧自检状态阻断。所有失败日志保留；T6固定预期按已确认152×102mm相纸表纠正为1795×1205，而非以6×4英寸另算。''',
 'docs/验证体系说明.md':'''当前基线v1.8、76需求/97用例/21局部实现，新增RC-07策略、页面隔离、颜色控件、SDK文件四个partial协议。全部主验收的质量/全规格/部署/真机缺口不因迁移完成而消失；完整覆盖门禁仍BLOCKED。Node控制、实际本地SDK和独立文件读取分栏，原失败证据保留。''',
 '每日开发日志/2026-11-04.md':'''持续开发已完成T2/T3/T5共享页面与平台适配、颜色/透明素材、T5自定义与KB、T3双自检及T4/T6隔离回归。core382、工具50、类型、162文件Lint、构建与调度回归通过。固定授权样本SDK与独立实际文件检查保留，最终证据见[验收报告](../docs/验证记录/RC-07-implementation/验收报告.md)。此前阶段“未完成”结论保留为历史。'''
}
for name in sections:
 if marker in (root/name).read_text():raise SystemExit('文档同步已执行，拒绝重复')
for name,body in sections.items():
 with (root/name).open('a') as f:f.write('\n'+marker+'\n\n'+body.strip()+'\n\n'+('[验收报告](docs/验证记录/RC-07-implementation/验收报告.md)。' if '/' not in name else '')+'\n')
p=root/'docs/覆盖矩阵.md';p.write_text((root/'docs/验证记录/RC-07-implementation/覆盖矩阵-最终.md').read_text().rstrip()+'\n')
