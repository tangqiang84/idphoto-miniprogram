"""RC-08增量文档登记，不重复执行。"""
from pathlib import Path
r=Path(__file__).resolve().parents[2]
marker='## RC-08 像素与导出一致性（2026-11-04）'
sections={
'项目资产与工具手册.md':'''新增core/outputEvidence.js：有效窗/处理像素证据与真实文件约束；services/exportInspection.ts：平台文件类型/尺寸/字节核验；core/printGeometry.js：相纸放置点毫米坐标后一次舍入。

验证入口：core/__tests__/outputEvidence.test.js、printGeometry.test.js；工具链/tests/dpi_evidence.test.js、output_matrix.test.js、print_output.test.js。工具链/smoke_output_matrix.js只接受--app禁云副本/--port/--out新目录，生成T5九规格双档及T6固定几何真实文件。工具链/_tmp/rc08_files.py使用现有Pillow独立读取；rc08_implement.py、rc08_registry.py、rc08_docs.py为本轮实现/登记留存脚本，不应重复运行。后续审计脚本rc08_audit.py核验源码与构建/报告链接，不生成业务通过结论。''',
'技术架构说明.md':'''有效窗、工作画布、分割入口、处理裁剪区及目标像素分别放入pixelEvidence；分割入口不冒充神经模型内部输入。exportInspection统一最终文件核验，平台依赖不进入core；outputEvidence和printGeometry保持纯逻辑。工作流硬检查失败清空成品，按工具改写checks后重算汇总。''',
'小程序开发指南.md':'''档位语义沿用用户确认：mm×dpi换算像素，不承诺写入文件DPI。DpiStep仅使用原图有效窗判断细节，工作图不得替代；无有效窗显示未知。最终成品以getImageInfo真实尺寸/格式及原始字节判定，KB显示取整不能参与边界判断。新文件核验/几何测试须连同四工具与T6回归。''',
'产品功能清单.md':'''T1/T2/T3/T5档位屏区分原图裁剪像素不足与处理分辨率不足；T5自定义固定像素也评估。导出核验真实文件格式、尺寸、字节；300档机构KB严格、600档机构项只提示，T5显式上限不豁免。T6毫米坐标后一次舍入并核验落盘；开启参考线会写入拼版图。DPI元数据无写入承诺，不以像素足够宣称质量达标。''',
'页面原型设计.md':'''档位屏300/600文案为输出像素档位，展示原图有效裁剪/处理分辨率不足或证据缺失提示；T5自定义目标固定且不随dpi翻倍。成品保留放大风险与文件元数据说明。T6参考线开启会写入拼版图，无法容纳不给预览保存。物理规格与流程不新增需求；可点击原型本轮只同步相关文案。''',
'测试用例与验收清单.md':'''RC-08固定规格9×2数值、四工具72页面/适配路径、16相纸×9规格几何；小裁剪/工作放大/缺失证据、格式不符、300上限多一字节/下限少一字节、600提示、T5显式上限及二次字节变大均有反例。SDK固定样本文件与Node替身分开；不以单元数目或图片存在替代独立读图。''',
'docs/验证体系说明.md':'''新增RC-08像素、最终文件、排版与SDK四项partial协议，累计76需求/101协议/25局部实现；主验收缺口仍76，不把本任务局部证据升级为全产品发布通过。构建使用独占快照；SDK仅禁云本地样本，不证明真实模型或实体打印机。''',
'开发任务台账.md':'''RC-08已进入实际实现与收尾验证：原图有效像素/处理像素分离、导出实际格式尺寸字节、DPI文案、T6几何已接入；最终状态以整改任务与本轮验收报告为准，不从旧完成标签推断。''',
'问题台账.md':'''本轮修复已复现的KB取整误放行、有效窗缺失时工作图误自证、最终文件格式/尺寸未核验、T6像素坐标累计舍入和参考线文案不实。二次核验反例另补硬失败清空成品及汇总重算。未把不可达照片旋转分支宣称为实际缺陷或SDK覆盖；历史失败与独立期望修正理由保留。''',
'每日开发日志/2026-11-04.md':'''RC-08依赖RC-07已满足后开工，读取PRD/原型/规格及相纸表。未新增依赖、未改生产dist，原有工作区改动保留。实现、反例、类型失败/登记失败及SDK失败原因均留新目录；最终验证和剩余风险见报告。''',
}
for name,body in sections.items():
 p=r/name;s=p.read_text() if p.exists() else '# 每日开发日志\n'
 if marker in s:raise SystemExit('拒绝重复追加:'+name)
 prefix='../docs/' if name.startswith('每日开发日志/') else '' if name.startswith('docs/') else 'docs/'
 suffix='\n\n说明见['+'RC-08说明]('+prefix+'RC-08像素与导出一致性说明.md)。证据见本轮RC-08-implementation验收报告；不代表全量发布通过。\n'
 p.write_text(s.rstrip()+'\n\n'+marker+'\n\n'+body+suffix)
