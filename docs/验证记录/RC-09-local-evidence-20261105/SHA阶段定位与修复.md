# 真机SHA阶段定位与修复

2026-11-05。只读恢复后已从真实iPhone取回queued、cache-read、cache-sha256三条持久记录；同一runId有序，cache-read到cache-sha256约12ms，此后无cache-verified或native-create。证据device-single-01/recovered-records.json。至此可把现场范围缩到SHA校验区间，不能说已证明模型不兼容或跨境网络原因。

同步SHA256对25,888,640字节执行完整计算，不向事件循环让步；改为共享分块生成器，保留同步API，新增sha256Async每1024块让出事件循环并检查取消/授权。modelService和诊断前置固定摘要均改用异步，不跳过摘要、不改变期望SHA或质量阈值。创建模型的行为未变。

400 core、85工具、类型、Lint193通过；完整模型本机异步摘要与Node crypto一致且有心跳，见sha-weight-benchmark.json。Node计时不作为手机性能。新隔离构建run-21cbbf91dc4d成功，仍待手机验证cache-verified及原生创建；原生输出0，RC-09/质量门禁不解除。取消测试明确不能返回摘要。所有旧失败记录保留，未部署或提交。
