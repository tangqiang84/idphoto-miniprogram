"""RC-09必要文档增量同步；保留历史与资源缺口。"""
from pathlib import Path
r=Path(__file__).resolve().parents[2];marker='## RC-09 可执行部分与资源待验收（2026-11-04）'
sections={
'项目资产与工具手册.md':'''新增core/mattingEvidence.js来源/安全原因码，core/sha256.js权重字节摘要，components/MattingStatus预览/成品来源与未评审提示。modelService实际接到t1Processing，segment透传spec；传统/模型自报/模拟/未知分类不混用。

工具：工具链/smoke_model.js现在支持--checks-only或--app禁云副本 --port端口 --out新目录，使用当前步骤链；smoke_model_legacy.js仅历史资产，禁止直接执行其旧固定截图路径。smoke_rc07.js新增--matting yes；_tmp/rc09_sdk_run.py串行四工具。rc09_matting_probe.js --out新目录生成固定本地技术图集；_tmp/rc09_samples.py使用现有Pillow运行时，非生产依赖。rc09_capabilities.js --out新文件做仓库默认盘点；rc09_acceptance.js --out新文件对资源门禁返回3/BLOCKED。_tmp/rc09_files.py独立读SDK文件；rc09_implement.py、rc09_registry.py、rc09_docs.py为修改/登记留存，不应重复执行，rc09_audit.py为收尾核验。

当前资源清单8 BLOCKED、1 SKIPPED。真实模型、境内部署、固定真实图集/人工评审及实体机未验收；图集技术执行不等于视觉通过。''',
'技术架构说明.md':'''平台modelService负责固定资产/运行时/异步文件/会话加载；core负责SHA、参数化模型推理/路由与来源证据。session+spec+modelInfo从统一处理层传递，T5提前返回。模型准备、抠图与云时间分开；provider自报不证明部署，质量统一未评审。失败有安全原因码，当前处理日志带TraceID，不输出原始服务载荷。''',
'小程序开发指南.md':'''RC-09默认关闭模型，缺固定SHA/转换与许可引用/运行时版本不得点亮。不得使用规格表commercialOk代替具体权重许可。缓存摘要读取实际字节计算，校验失败不删旧文件；下载用唯一临时路径。测试应区分替身推理与真实模型、Node/模拟器与实体机、技术成品与视觉质量。资源门禁与本地验证命令见RC-09说明。''',
'产品功能清单.md':'''T1/T2/T3预览与成品显示真实来源类别、降级原因及未评审提示，传统算法明确非AI；T5/T6不增加人脸模型处理。当前仍无真实模型权重/运行时与部署证据，发丝级与复杂背景质量不标完成。浅衣高置信低IoU反例保留，数值置信不能承诺视觉质量或审核结果。''',
'测试用例与验收清单.md':'''RC-09包含固定摘要/异步缓存/Tensor与规格传递、推理异常/NaN/超时、下载失败冷却、授权/配置变化迟到丢弃；云断网/额度/超时替身和shadow/stub/未知来源单列。合成复杂/浅衣/细线与授权REAL-111技术图集不算人工视觉验收。资源清单8阻塞1未执行，不能把技术测试通过改为真实模型/真机质量通过。''',
'页面原型设计.md':'''抠图预览/成品补来源与质量风险；传统、模型、模拟分别标识，数字置信与视觉达标分开。HTML只做来源示意，不作为处理证据；实际页面从本次结果显示来源、原因及分别计时。删除原型美颜“保证审核通过”的承诺，实际审核仍依机构口径。''',
'docs/验证体系说明.md':'''RC-09追加5项partial协议，累计76需求/106协议/30局部实现，主验收缺口仍76。rc09_acceptance读取资源清单并核对PASS证据文件/哈希，不评判报告内容语义或替代人工；资源缺失返回3/BLOCKED，额度真实调用SKIPPED不是通过。代码检查、替身/技术图集、禁云SDK、真实模型/实体机四层分开。''',
'开发任务台账.md':'''RC-09按用户“暂无资源，先完成可执行部分”推进接线、固定权重保护、来源分类、降级和技术验证；总体保留待验收，不关闭真实模型/部署/视觉/实体机缺项，不提前进入依赖RC-09的正式质量验收。''',
'问题台账.md':'''已修复生产未接模型初始化、segment漏spec、异步缓存未等待/配置摘要未生效、Tensor未注入、传统/影子/模拟来源可能冒充精修及缺少失败分类。保留浅衣0.989置信但约0.254 IoU反例；不调阈值声称发丝质量达标。资源不足作为外部待验收，不计完成。''',
'每日开发日志/2026-11-04.md':'''RC-09用户确认暂无真实资源，先完成可执行部分。实现模型接线/固定摘要/来源与降级；传统算法固定样本4个技术执行、视觉通过0。默认无权重下载、不调用外部收费/上传、不部署或读密钥；失败证据与资源缺口保留，最终结果见本轮报告。'''
}
for name,body in sections.items():
 p=r/name;s=p.read_text()
 if marker in s:raise SystemExit('拒绝重复追加:'+name)
 prefix='../docs/' if name.startswith('每日开发日志/') else '' if name.startswith('docs/') else 'docs/'
 p.write_text(s.rstrip()+'\n\n'+marker+'\n\n'+body+'\n\n说明见[RC-09能力与降级说明]('+prefix+'RC-09能力与降级说明.md)。资源状态以本轮验收报告和清单为准，不代表全产品发布通过。\n')
