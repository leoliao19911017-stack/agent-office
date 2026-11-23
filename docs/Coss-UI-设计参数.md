# Coss UI 设计参数（实测）

> 来源：https://coss.com/ui 真机抓取 `getComputedStyle` + CSS 变量（2026-11-24）
> 定位：**开发者工具风聊天组件库**（Cal.com 团队出品，Base UI + Tailwind）

---

## 一、色彩 token（浅色）

```css
--background:       #FFFFFF;              /* 纯白，不是米白 */
--foreground:       #262626;              /* neutral-800 */
--border:           rgba(0,0,0,0.08);     /* #00000014 */
--input:            rgba(0,0,0,0.10);     /* #0000001a */
--muted:            rgba(0,0,0,0.04);     /* #0000000a */
--muted-foreground: #686868;
--ring:             neutral-400;

/* 语义色（只用于状态，不用来装饰） */
--destructive:      red-700
--info:             blue-700
--success:          emerald-700
--warning:          amber-700
```

## 二、色彩 token（深色）

```css
--background:       #141414;
--foreground:       neutral-100;          /* #f5f5f5 */
--border:           rgba(255,255,255,0.06);  /* #ffffff0f */
--muted:            rgba(255,255,255,0.04);  /* #ffffff0a */
--muted-foreground: #818181;

--destructive:      red-400
--info:             blue-400
--success:          emerald-400
--warning:          amber-400
```

---

## 三、几何

```css
--radius: 0.625rem;   /* 10px 基础 */

卡片      16px
按钮      10px      高 32px
输入框    14px      最小高 48px
头像      36px 圆形
```

## 四、字体

```
字族      fontSans（几何无衬线）
基础字号   16px
按钮      14px / 500
输入框    14px
气泡正文   13-14px
姓名/时间  11-12px，--muted-foreground
```

## 五、组件实测参数

### 5.1 卡片
```css
background: #fff;
border: 1px solid rgba(0,0,0,.08);
border-radius: 16px;
box-shadow: 0 1px 2px rgba(0,0,0,.05);
```

### 5.2 按钮
```css
border-radius: 10px;
height: 32px;
font-size: 14px;
font-weight: 500;
/* 默认（次要）：透明底 + 文字色 #262626 */
```

### 5.3 聊天组件（重点）

```
气泡       大圆角（接近 16-20px）
           收发都是浅灰，靠「左右对齐 + 是否显示头像姓名」区分，不靠颜色
  
接收消息   左对齐，带头像 + 姓名，气泡左对齐
发送消息   右对齐，不显示头像和姓名

头像       36px 圆，姓名缩写，浅桃色底 + 深色字，右下角绿色在线点
时间戳     气泡下方，小字（11-12px），#686868
已读状态   发送方时间戳旁有细双勾
reaction   气泡下方小胶囊，如「❤️ 1」
```

### 5.4 输入框（Composer）
```
文字 14px，最小高 48px，圆角 14px
容器上方圆角 14px 14px 0 0（贴底时）
带附件按钮、发送按钮（图标）
```

### 5.5 分段切换
```
外容器：浅灰轨道
选中项：纯白实心 + 轻投影，胶囊圆角
未选中：灰色文字
```

---

## 六、和 CrommaCode 的关系

**两套不同语言，各管一块：**

```
CrommaCode   暖米白 #F6F1EA + 点阵网格 + 琥珀
             → 用于：看板骨架、仪表盘、数据卡
             → 气质：精密仪器

Coss UI      纯白 + 中性灰 + 几乎无彩色
             → 用于：聊天面板、输入框、气泡、列表
             → 气质：开发者工具
```

**老板要求：全部切换到 Coss UI。**

**切换方式：** 看板整体改用 Coss 的中性色系，**丢掉暖米白和点阵网格**，
保留 Cromma 里「信息密度 + 等宽数字 + 克制」的优点，但视觉语言换成 Coss 的干净中性。

---

## 七、禁止

```
× 用彩色区分消息收发方（靠对齐）
× 用大阴影（0 1px 2px 就够）
× 渐变、发光
× 彩色标签堆砌
× 字号小于 11px
× 假按钮（长得能点但没反应）
```

---

## 八、参考实现

官网组件源码可直接读（复制即用，但我们是纯 HTML/CSS，要手写等价样式）：

```
组件列表    https://coss.com/ui
聊天        https://coss.com/ui/chat
Composer    https://coss.com/ui/docs/components/composer
Button      https://coss.com/ui/docs/components/button
Card        https://coss.com/ui/docs/components/card
```
