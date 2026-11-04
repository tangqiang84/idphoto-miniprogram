from pathlib import Path
r=Path.cwd()
p=r/'docs/整改开发任务.md';s=p.read_text().replace('| RC-08 | P1 | 真实裁剪像素、档位和最终导出一致性 | RC-07 | 待办 |','| RC-08 | P1 | 真实裁剪像素、档位和最终导出一致性 | RC-07 | 进行中 |');p.write_text(s)
p=r/'docs/RC-08开工检查.md';s=p.read_text();s+='''
## 正式开工（2026-11-04）

已复读RC-08条款、PRD H2/AC4/K、原型档位步骤、规格/相纸参考表、RC-07报告及对应源码测试。依赖完成，现有改动与缓存保留。沿用已确认的像素档位语义，不承诺写入dpi元数据；本轮无新需求裁决项。

影响T1/T2/T3/T5档位及导出、T6排版。基线复现：204801字节超过200KB，被旧适配Math.round成200后判通过；DpiStep在有效裁剪像素缺失时仍使用workW/H；排版只取请求画布尺寸未复核落盘。失败证据在验证记录/RC-08-implementation。

计划修改DpiStep、compose/outputEvidence、exportInspection、t1Processing/renderService、T1/PhotoTool、paperLibrary/T6及相应测试/文档。断言：小裁剪/工作放大警告；9×2独立尺寸；300KB边界原始字节、600提示与T5显式上限；真实格式/尺寸核验；元数据不承诺；T6几何、旋转、单张限制。排除模型/模板质量、生命周期与发布真机任务，不新增依赖、不改生产dist、不提前提交。
''';p.write_text(s)
