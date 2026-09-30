import { h, defineComponent } from "vue";
import { Icon as IconifyIcon, addIcon } from "@iconify/vue/dist/offline";
import type { IconifyIcon as IconifyIconData } from "@iconify/vue";

// Iconify Icon在Vue里本地使用（用于内网环境）
export default defineComponent({
  name: "IconifyIconOffline",
  components: { IconifyIcon },
  props: {
    icon: {
      default: null
    }
  },
  render() {
    // addIcon 支持传入整个 icon collection 对象（第一个参数即数据本身）；
    // 新版 @iconify/vue 类型将两参分别收窄为 string / IconifyIcon，
    // 此处按运行时行为断言（该写法来自 pure-admin 模板）
    if (typeof this.icon === "object")
      addIcon(
        this.icon as unknown as string,
        this.icon as unknown as IconifyIconData
      );
    const attrs = this.$attrs;
    if (typeof this.icon === "string") {
      return h(
        IconifyIcon,
        {
          icon: this.icon,
          "aria-hidden": false,
          style: attrs?.style
            ? Object.assign(attrs.style, { outline: "none" })
            : { outline: "none" },
          ...attrs
        },
        {
          default: () => []
        }
      );
    } else {
      return h(
        this.icon,
        {
          "aria-hidden": false,
          style: attrs?.style
            ? Object.assign(attrs.style, { outline: "none" })
            : { outline: "none" },
          ...attrs
        },
        {
          default: () => []
        }
      );
    }
  }
});
