from pathlib import Path
import json
r=Path.cwd()
p=r/'每日开发日志/2026-11-04.md';s=p.read_text().replace('](docs/RC-08像素与导出一致性说明.md)','](../docs/RC-08像素与导出一致性说明.md)');p.write_text(s)
p=r/'工具链/_tmp/rc08_docs.py';s=p.read_text().replace("prefix='' if name.startswith('docs/') else 'docs/'", "prefix='../docs/' if name.startswith('每日开发日志/') else '' if name.startswith('docs/') else 'docs/'");p.write_text(s)
p=r/'docs/整改开发任务.md';s=p.read_text().replace('| RC-08 | P1 | 真实裁剪像素、档位和最终导出一致性 | RC-07 | 进行中 |','| RC-08 | P1 | 真实裁剪像素、档位和最终导出一致性 | RC-07 | 完成 |');s=s.replace('## RC-08 清晰度与最终导出\n','''## RC-08 清晰度与最终导出

- 收尾（2026-11-04）：有效窗/工作/分割入口/处理裁剪/目标像素分开溯源，最终格式尺寸与原始字节核验、DPI像素档位文案、T6毫米坐标及单张限制已完成。核心387、工具61（含四工具72路径）、类型、Lint171、构建通过；四工具微信成功成品、T5九规格双档/T6矩阵、27个实际文件独立读取通过。完整发布覆盖仍BLOCKED、实体机/模型/模板质量归后续。见[说明](RC-08像素与导出一致性说明.md)、[验收报告](验证记录/RC-08-implementation/验收报告.md)。
''');p.write_text(s)
p=r/'docs/RC-08开工检查.md';s=p.read_text().replace('# RC-08开工检查\n','''# RC-08开工检查

## 当前状态：完成（2026-11-04）

本轮实现、验证与文档更新已完成。核心387、工具61、类型/Lint171/构建、四工具微信及27实际文件独立读取通过，详见[验收报告](验证记录/RC-08-implementation/验收报告.md)。以下未实施/待确认描述均为历史开工留痕，不代表当前状态；未新增需求裁决。
''');p.write_text(s)
p=r/'开发任务台账.md';s=p.read_text().replace('RC-08已进入实际实现与收尾验证：','RC-08已完成实现、验证与文档更新：').replace('最终状态以整改任务与本轮验收报告为准，不从旧完成标签推断。','核心387、工具61、类型/Lint171/构建、四工具微信及27实际文件独立读取通过。最终状态以整改任务与本轮验收报告为准，不从旧完成标签推断。');p.write_text(s)
p=r/'docs/验证记录/RC-08-implementation/验收报告.md';s=p.read_text().replace('当前为收尾核验；最终任务状态见整改任务。','RC-08本任务完成；逐项断言及关联回归通过，相关文档已同步。');s=s.replace('最终文件与一致性报告写入本目录files-complete.json、checks-final.json。完成后状态以这些报告及整改任务为准；失败版本全部保留，最终证据只绑定上述冻结源码构建。','''独立读取[27个文件报告](files-complete.json)全部PASS：文件DPI均未设置，JPEG的JFIF density为1×1且无物理DPI单位，PNG无DPI字段；不是300/600实测元数据。五种相纸白角验证通过；T2 PNG保留连续Alpha，不将此解释为抠图质量达标。

最终一致性报告为本目录checks-final.json，核验137项应用输入、117项禁云同源文件、两套各43项产物、4项依赖/锁文件及SDK/27实际文件/文档链接。失败版本全部保留，最终证据只绑定上述冻结源码构建。首轮审计仅日报相对链接失败，修正后重新审计；没有改业务来迁就证据。

`git diff --check`通过。本轮未提交Git，未自动开始下一任务。''');p.write_text(s)
p=r/'docs/验证记录/RC-08-implementation/根因与实验记录.md';p.write_text(p.read_text()+'''\n10. 汇总重算首版对check返回的推断联合类型重新赋值导致TS2322；工具测试通过但类型闸门正确阻止继续Lint/构建。改为独立finalReport值后类型通过，重新生成两套构建，并在冻结源码上重跑全部SDK，未复用修改前SDK冒充通过。\n11. 文档初次审计发现日报目录相对链接少../，其他应用/构建/SDK/27文件全部通过。修复链接并重新审计，保留首版FAIL。覆盖矩阵工具--print只输出stdout，不写--out；按工具实际write模式独占生成，原版本已备份，属于工具参数误用而非业务失败。\n''')
p=r/'docs/RC-01需求与现状基线.md';p.write_text(p.read_text().rstrip()+'\n\nRC-08更新（2026-11-04）：v1.9同步原图有效像素、实际文件和相纸几何现状及局部证据，76条需求描述/独立验收要求不变；基线最初“未改业务”属于初次交付历史，本轮业务验证以RC-08报告为准。\n')
p=r/'docs/rc01-baseline.json';b=json.loads(p.read_text());b['scope']='需求/现状基线；业务验收按各RC本轮报告分别记录，不代表全产品发布通过';p.write_text(json.dumps(b,ensure_ascii=False,indent=2)+'\n')
