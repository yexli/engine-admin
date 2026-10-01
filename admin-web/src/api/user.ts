import { http } from "@/utils/http";

export type UserResult = {
  success: boolean;
  msg?: string;
  data: {
    /** 头像 */
    avatar: string;
    /** 用户名 */
    username: string;
    /** 昵称 */
    nickname: string;
    /** 当前登录用户的角色 */
    roles: Array<string>;
    /** 按钮级别权限 */
    permissions: Array<string>;
    /** `token`（M3.1 起为管理会话令牌，经 x-admin-session 头使用） */
    accessToken: string;
    /** 用于刷新会话的 token（7 天内可轮换） */
    refreshToken: string;
    /** `accessToken` 的过期时间（ISO） */
    expires: Date;
  };
};

export type RefreshTokenResult = {
  success: boolean;
  data: {
    /** `token` */
    accessToken: string;
    /** 用于刷新会话的 token */
    refreshToken: string;
    /** `accessToken` 的过期时间（ISO） */
    expires: Date;
  };
};

/** 登录（M3.1 起真实：管理监听签发会话；响应形状与原 Mock 一致，前端零改动） */
export const getLogin = (data?: object) => {
  return http.request<UserResult>("post", "/control-api/v1/admin/session/login", {
    data
  });
};

/** 刷新会话（轮换出全新 token 对） */
export const refreshTokenApi = (data?: object) => {
  return http.request<RefreshTokenResult>(
    "post",
    "/control-api/v1/admin/session/refresh-token",
    { data }
  );
};

/** 登出（吊销当前会话；失败静默——本地清理照常进行） */
export const logoutSession = () => {
  return http.request<{ success: boolean }>(
    "post",
    "/control-api/v1/admin/session/logout"
  );
};
