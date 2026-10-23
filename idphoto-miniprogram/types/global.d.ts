// 全局类型声明（小程序运行时全局对象）
// 说明：tsconfig 的 include 已含 "./types"，但该目录此前缺失，
// 导致 `wx` 全局在 tsc --noEmit 下报 TS2304（onnxMatting.ts 与 faceService.ts 共 6 处）。
// 此处补最小声明，只声明本项目实际使用到的成员，其余按 any 兜底。

declare const wx: any;
declare const App: any;
declare const Page: any;
declare const Component: any;
declare const getApp: any;
declare const getCurrentPages: any;
