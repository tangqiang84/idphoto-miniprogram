# 换装人脸后备服务

用途：仅供T1/T3在端侧没有取得可靠单脸时，在上云与换装双授权下请求。端侧已检出多人时不调用后备服务。无可靠结果安全拒绝，不伪造关键点或置信度。

已部署原环境独立facepoints事件函数，Python3.11、512MB、20秒；固定MediaPipe0.10.32、官方FaceLandmarker float16/1模型。模型SHA在index.py中锁定。依赖采用标准公开API导入，Linux离线包验证通过；不使用早期实验的模块注入。

输入JPEG/PNG base64和真实宽高；purpose=suit_face_landmarks，consent=faceCloudEnhance，suitConsent=suitSwap，region=CN，retain/train=false。这些字段是请求契约，不替代平台身份访问控制。图片不写盘、不拼接到日志；错误日志含code与TraceID。

最多检测两脸，0脸或多脸拒绝；成功返回478个像素坐标点、点集包围盒、来源和模型SHA。rectSource=landmark-envelope，confidence=null，不冒充独立检测框或置信概率。不返回身份向量、表情分类或变换矩阵。

标准运行包、依赖许可和真实云非人像测试证据：docs/验证记录/RC-10-face-runtime-20261122-01。模型点仍经现有core/face计算头长，头顶由工程比例推导，不能宣称为直接测量的头顶。

跨样本视觉和真实完整云链须独立验收；函数Active或无人拒绝不代表真人质量已通过。境内、不留存等完整承诺仍须结合实际平台配置与服务条款，不能仅靠本函数代码证明。
