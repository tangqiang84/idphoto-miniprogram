# RC-10 研究服装解析后端（未部署、未接入前端）

采用作者固定 SegFormer B2 Clothes ONNX，SHA256在index.py固定。model.onnx须由发布资产验证后打包，禁止请求时下载未知权重。当前无生产依赖安装或云资源变更。

运行依赖：Python 3.11兼容的numpy、Pillow、onnxruntime CPU。用于替代微信原生推理依赖，不需要GPU；必须为部署平台构建依赖，不能上传macOS二进制。前端Taro依赖和锁文件不变。

本地实际验证环境为现有Python、numpy、Pillow、ORT 1.23.2；尚未完成Linux包验证，不将不固定的requirements部署。模型110MB；本机首次完整请求峰值约853MiB，因此不支持默认256MB配置，部署前核对云函数内存、时限及费用授权。不得把本机测量当云端资源保证。

接口接收JPEG/PNG base64、准确width/height，必须同时consent=faceCloudEnhance、suitConsent=suitSwap、purpose=suit_clothing_parse、region=CN、retain=false、train=false。模型返回宽高一致的单字节类别图base64和固定模型来源；不返回生成照片。授权字段只是请求契约，不能取代平台身份验证及业务授权。

当前函数不写照片或载荷日志；日志仅错误码和TraceID。不留存/不训练/境内处理的部署承诺需要独立服务配置证据，不能仅从本函数代码推断。尚无云端成功记录，未发送新的云照片请求。前端尚未切换到该函数。

2026-11-22补充：Linux x86_64/Python3.11固定依赖、断网推理及ZIP解压独立执行已通过，依赖锁/包摘要见docs/验证记录/RC-10-linux-20261122-01。此为本地容器证据，尚未验证目标云ABI或部署。压缩包153832418字节、解压267174217字节，不能走50MB直接上传。云配置查询已纠正为成功，当前旧posekey为Nodejs运行时且CreateFailed，禁止沿用错误配置部署Python。

2026-11-22更新：已在原环境部署Python3.11/1536MB/30秒事件函数，状态Active；无授权拒绝与非人像合成图云推理通过，T1/T3源码已接入，尚未上传发布小程序。此前“未部署/未接入”和当前账户“默认256MB不可调整”的推断已过时，以docs/验证记录/RC-10-cloud-deploy-20261122-01/验收报告.md为准。
