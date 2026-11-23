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
      '2. 诊断信息：处理失败时可能记录原因码、处理耗时或调用标识，用于定位故障。应用诊断日志不记录照片或人脸像素。',
      '3. 我们不收集您的通讯录、位置、通话记录、短信、设备标识符等无关信息。',
    ],
  },
  {
    title: '二、人脸属于敏感个人信息，我们如何处理',
    items: [
      '1. 端侧优先：人脸抠图与合成默认在您的手机本地完成，不出设备。',
      '2. 单独同意：每次涉及人脸的处理前，我们会以独立弹窗向您告知并取得您的单独同意；未勾选同意，处理不会启动（也不会在后台偷偷降级处理）。',
      '3. 云端增强由您另行选择。开启后，裁剪后的人像区域会按需发送至腾讯云 CloudBase；抠图增强可调用百度智能云人像分割服务。',
      '换装须单独同意。您同时同意云端增强和换装后，腾讯云 CloudBase 上的服务将按需分析裁剪后人像的人脸关键点、双肩、衣物和领口，其中双肩识别可调用百度智能云人体关键点服务。职业装在设备上合成。',
      '4. 本地临时数据：离开工具页后释放会话中的照片和预览引用。微信管理本次处理产生的临时文件，您主动保存在相册中的成品由您管理。',
    ],
  },
  {
    title: '三、我们如何使用信息',
    items: ['仅用于向您提供证件照生成、换底色、规格转换、合规检测服务，不会用于广告推荐、用户画像或对外转让。'],
  },
  {
    title: '四、信息共享、转让与公开',
    items: [
      '我们不会出售您的照片与人脸信息。',
      '您单独授权云端增强后，腾讯云 CloudBase 和百度智能云按上述用途处理裁剪后的人像。换装相关云调用还需您单独同意换装。',
      '您可以在功能页撤回授权，停止后续相关上传。',
    ],
  },
  {
    title: '五、存储期限',
    items: ['微信临时文件由平台管理。云端数据与日志的存储期限需结合服务配置和服务条款确认。'],
  },
  {
    title: '六、您的权利',
    items: [
      '撤回同意：在功能页取消对应授权即可撤回。撤回上云不影响重新发起本地处理，撤回换装后不能继续换装，撤回本地授权后不能再选图或拍摄；页面旧结果及在途结果失效。已发出的请求无法撤回，手机相册内已保存照片不受影响。',
      '删除：您可在手机相册中删除已保存的照片，或通过下方联系方式咨询本次处理涉及的数据。',
      '投诉与咨询：tangqiang@vip.126.com，我们承诺在 15 个工作日内答复。',
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
        <Text className='privacy-page__date'>更新日期：2026 年 11 月 23 日</Text>
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
        <Text className='privacy-page__foot-line'>备案号：苏ICP备2026082326号-1X</Text>
      </View>
    </View>
  );
}
