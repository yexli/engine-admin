FROM node:20-alpine as build-stage

WORKDIR /app
RUN corepack enable
RUN corepack prepare pnpm@latest --activate

RUN npm config set registry https://registry.npmmirror.com

COPY .npmrc package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# 说明：仓库 build 脚本含 NODE_OPTIONS 内联环境变量（POSIX 写法），
# Windows cmd 下不生效；Linux 容器内正常。
RUN pnpm build

FROM nginx:stable-alpine as production-stage

COPY --from=build-stage /app/dist /usr/share/nginx/html
# 管理面生产路由：/control-api 由 nginx 注入 x-admin-token（服务端注入，浏览器不持有）；
# 启动必须提供 PLATFORM_ADMIN_TOKEN / PLATFORM_ADMIN_UPSTREAM / PLATFORM_PUBLIC_UPSTREAM，
# 否则管理面调用全部 401（fail closed）。TLS 在入口层终结或自配 listen 443 ssl。
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
