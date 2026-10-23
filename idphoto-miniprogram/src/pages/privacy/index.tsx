import { View, Text } from '@tarojs/components';
import './index.scss';

// 隐私政策全文页（PRD 提审硬门槛：政策全文须在小程序内可触达）
// 文本来源：《用户隐私保护指引与隐私政策.md》第 2 节，与 privacy.js 行为一一对应；
// 代码若改动收集范围/上云逻辑/留存期限，必须同步改此页并重新对照（文档第 6 节维护约定）。

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: '一、我们收集哪些信息',
    items: [
      '1. 您主动上传的照片：您从相册选择的照片（含其中的人脸图像），用于生成证件照。',
      '2. 设备与日志信息：为定位故障与保障服务稳定，我们可能记录处理时间、是否使用云端增强、处理耗时等非内容性信息；该类日志不含照片内容、不含人脸数据，保留 90 天。',
      '3. 我们不收集您的通讯录、位置、通话记录、短信、设备标识符等无关信息。',
    ],
  },
  {
    title: '二、人脸属于敏感个人信息，我们如何处理',
    items: [
      '1. 端侧优先：人脸抠图与合成默认在您的手机本地完成，不出设备。',
      '2. 单独同意：每次涉及人脸的处理前，我们会以独立弹窗向您告知并取得您的单独同意；未勾选同意，处理不会启动（也不会在后台偷偷降级处理）。',
      '3. 云端增强（可选，需您另行授权）：当本地精度不足时，您可以选择启用云端增强。此时：仅上传裁剪后的人像区域，不是完整原图；传输与处理均在中国境内完成，不跨境；处理完成即时删除，不留存、不用于任何模型训练；您可随时不启用该项，不影响本地处理功能的使用。',
      '4. 本地销毁：处理完成后，本地临时数据即时销毁。',
    ],
  },
  {
    title: '三、我们如何使用信息',
    items: ['仅用于向您提供证件照生成、换底色、规格转换、合规检测服务，不会用于广告推荐、用户画像或对外转让。'],
  },
  {
    title: '四、信息共享、转让与公开',
    items: ['我们不会向任何第三方共享、转让或公开您的照片与人脸信息。云端增强所使用的云能力提供方仅按我们的指令完成计算，无权留存或另作他用。'],
  },
  {
    title: '五、存储期限',
    items: ['照片与人脸数据：处理完成即删除，不做留存。非内容性日志：保留 90 天用于故障排查与安全审计。'],
  },
  {
    title: '六、您的权利',
    items: [
      '撤回同意：您可在小程序内关闭云端增强授权，撤回后不再触发上云处理。',
      '删除：本产品不留存您的照片，无需申请删除；如需删除本地已保存的图片，请在手机相册中操作。',
      '投诉与咨询：xlltq@163.com，我们承诺在 15 个工作日内答复。',
    ],
  },
  {
    title: '七、未成年人信息',
    items: ['本服务面向 18 周岁以上用户。若您未满 18 周岁，请在监护人陪同下使用。'],
  },
  {
    title: '八、政策更新',
    items: ['本政策如有变更，我们将在小程序内提示；涉及人脸处理方式的重大变更，将重新取得您的单独同意。'],
  },
];

export default function Privacy() {
  return (
    <View className='privacy-page'>
      <View className='privacy-page__head'>
        <Text className='privacy-page__title'>隐私政策</Text>
        <Text className='privacy-page__date'>更新日期：2026 年 10 月 23 日 ｜ 生效日期：2026 年 10 月 23 日</Text>
      </View>

      {SECTIONS.map((s) => (
        <View key={s.title} className='privacy-page__section'>
          <Text className='privacy-page__section-title'>{s.title}</Text>
          {s.items.map((it, i) => (
            <Text key={i} className='privacy-page__item'>{it}</Text>
          ))}
        </View>
      ))}

      <View className='privacy-page__foot'>
        <Text className='privacy-page__foot-line'>运营主体：个人开发者</Text>
        <Text className='privacy-page__foot-line'>备案号：ICP 备案审核中（通过后更新）</Text>
      </View>
    </View>
  );
}
