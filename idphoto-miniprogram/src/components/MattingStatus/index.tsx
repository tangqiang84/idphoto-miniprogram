import { View, Text } from '@tarojs/components';

export default function MattingStatus({ evidence }: { evidence: any }) {
  if (!evidence) return null;
  return <View className='matting-status'>
    <Text className='tag'>处理来源：{evidence.label} · 本次抠图 {evidence.latencyMs}ms（模型准备 {evidence.initializationMs ?? '未记录'}ms，另计）</Text>
    {evidence.reasonCodes?.length ? <Text className='color-risk'>原因码：{evidence.reasonCodes.join('、')}</Text> : null}
    <Text className='tag'>{evidence.limitation}；视觉质量尚未完成评审。</Text>
    {evidence.kind === 'model' && !evidence.deploymentVerified ? <Text className='tag'>模型运行/服务自报不等于部署及视觉质量验收通过。</Text> : null}
  </View>;
}
