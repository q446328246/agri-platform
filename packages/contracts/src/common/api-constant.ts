/** REST 接口统一前缀，网关按此前缀路由 */
export const API_PREFIX = "/api/v1";

/** 链路标识请求头，网关生成后透传至全部下游 */
export const HEADER_REQUEST_ID = "x-request-id";

/** 租户标识请求头，由认证服务签发并透传 */
export const HEADER_TENANT_ID = "x-tenant-id";
