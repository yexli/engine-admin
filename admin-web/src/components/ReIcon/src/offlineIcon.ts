// 这里存放本地图标，在 src/layout/index.vue 文件中加载，避免在首启动加载
import { getSvgInfo } from "@pureadmin/utils";
import { addIcon } from "@iconify/vue/dist/offline";

// https://icon-sets.iconify.design/ep/?keyword=ep
import EpHomeFilled from "~icons/ep/home-filled?raw";
// 平台菜单与通用操作图标（离线注册，内网可用）
import EpOdometer from "~icons/ep/odometer?raw";
import EpCompass from "~icons/ep/compass?raw";
import EpCpu from "~icons/ep/cpu?raw";
import EpMagicStick from "~icons/ep/magic-stick?raw";
import EpCoin from "~icons/ep/coin?raw";
import EpCollection from "~icons/ep/collection?raw";
import EpWarning from "~icons/ep/warning?raw";
import EpSetting from "~icons/ep/setting?raw";
import EpRefresh from "~icons/ep/refresh?raw";
import EpRefreshRight from "~icons/ep/refresh-right?raw";
import EpSearch from "~icons/ep/search?raw";
import EpPlus from "~icons/ep/plus?raw";
import EpDelete from "~icons/ep/delete?raw";
import EpEdit from "~icons/ep/edit?raw";
import EpView from "~icons/ep/view?raw";
import EpCopyDocument from "~icons/ep/copy-document?raw";
import EpVideoPlay from "~icons/ep/video-play?raw";
import EpVideoPause from "~icons/ep/video-pause?raw";
import EpKey from "~icons/ep/key?raw";
import EpTimer from "~icons/ep/timer?raw";
import EpClock from "~icons/ep/clock?raw";
import EpTrendCharts from "~icons/ep/trend-charts?raw";
import EpPosition from "~icons/ep/position?raw";
import EpCircleCheck from "~icons/ep/circle-check?raw";
import EpCircleClose from "~icons/ep/circle-close?raw";
import EpInfoFilled from "~icons/ep/info-filled?raw";
import EpWarningFilled from "~icons/ep/warning-filled?raw";
import EpDocument from "~icons/ep/document?raw";
import EpDataLine from "~icons/ep/data-line?raw";
import EpConnection from "~icons/ep/connection?raw";
import EpLocation from "~icons/ep/location?raw";
import EpLink from "~icons/ep/link?raw";
import EpSwitchButton from "~icons/ep/switch-button?raw";
import EpList from "~icons/ep/list?raw";
import EpNotebook from "~icons/ep/notebook?raw";
import EpBox from "~icons/ep/box?raw";
import EpGuide from "~icons/ep/guide?raw";
import EpMapLocation from "~icons/ep/map-location?raw";
import EpHistogram from "~icons/ep/histogram?raw";
import EpPieChart from "~icons/ep/pie-chart?raw";
import EpMessageBox from "~icons/ep/message-box?raw";
import EpOpen from "~icons/ep/open?raw";
import EpMonitor from "~icons/ep/monitor?raw";
import EpBell from "~icons/ep/bell?raw";
import EpUser from "~icons/ep/user?raw";
import EpLock from "~icons/ep/lock?raw";
import EpCalendar from "~icons/ep/calendar?raw";
import EpFiles from "~icons/ep/files?raw";
import EpArrowRight from "~icons/ep/arrow-right?raw";
import EpDownload from "~icons/ep/download?raw";
import EpLightning from "~icons/ep/lightning?raw";

// https://icon-sets.iconify.design/ri/?keyword=ri
import RiSearchLine from "~icons/ri/search-line?raw";
import RiInformationLine from "~icons/ri/information-line?raw";

const icons = [
  // Element Plus Icon: https://github.com/element-plus/element-plus-icons
  ["ep/home-filled", EpHomeFilled],
  // 平台菜单
  ["ep/odometer", EpOdometer],
  ["ep/compass", EpCompass],
  ["ep/cpu", EpCpu],
  ["ep/magic-stick", EpMagicStick],
  ["ep/coin", EpCoin],
  ["ep/collection", EpCollection],
  ["ep/warning", EpWarning],
  ["ep/setting", EpSetting],
  // 通用操作
  ["ep/refresh", EpRefresh],
  ["ep/refresh-right", EpRefreshRight],
  ["ep/search", EpSearch],
  ["ep/plus", EpPlus],
  ["ep/delete", EpDelete],
  ["ep/edit", EpEdit],
  ["ep/view", EpView],
  ["ep/copy-document", EpCopyDocument],
  ["ep/video-play", EpVideoPlay],
  ["ep/video-pause", EpVideoPause],
  ["ep/key", EpKey],
  ["ep/timer", EpTimer],
  ["ep/clock", EpClock],
  ["ep/trend-charts", EpTrendCharts],
  ["ep/position", EpPosition],
  ["ep/circle-check", EpCircleCheck],
  ["ep/circle-close", EpCircleClose],
  ["ep/info-filled", EpInfoFilled],
  ["ep/warning-filled", EpWarningFilled],
  ["ep/document", EpDocument],
  ["ep/data-line", EpDataLine],
  ["ep/connection", EpConnection],
  ["ep/location", EpLocation],
  ["ep/link", EpLink],
  ["ep/switch-button", EpSwitchButton],
  ["ep/list", EpList],
  ["ep/notebook", EpNotebook],
  ["ep/box", EpBox],
  ["ep/guide", EpGuide],
  ["ep/map-location", EpMapLocation],
  ["ep/histogram", EpHistogram],
  ["ep/pie-chart", EpPieChart],
  ["ep/message-box", EpMessageBox],
  ["ep/open", EpOpen],
  ["ep/monitor", EpMonitor],
  ["ep/bell", EpBell],
  ["ep/user", EpUser],
  ["ep/lock", EpLock],
  ["ep/calendar", EpCalendar],
  ["ep/files", EpFiles],
  ["ep/arrow-right", EpArrowRight],
  ["ep/download", EpDownload],
  ["ep/lightning", EpLightning],
  // Remix Icon: https://github.com/Remix-Design/RemixIcon
  ["ri/search-line", RiSearchLine],
  ["ri/information-line", RiInformationLine]
];

// 本地菜单图标，后端在路由的 icon 中返回对应的图标字符串并且前端在此处使用 addIcon 添加即可渲染菜单图标
icons.forEach(([name, icon]) => {
  addIcon(name as string, getSvgInfo(icon as string));
});
