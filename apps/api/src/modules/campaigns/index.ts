export {
  CUSTOMER_AUDIT_FIELDS,
  CUSTOMER_CREATED_ACTION,
  CUSTOMER_DISPLAY_NAME_MAX_LENGTH,
  CUSTOMER_LIST_DEFAULT_LIMIT,
  CUSTOMER_LIST_MAX_LIMIT,
  CustomerService,
  normalizeCustomerDisplayName,
  normalizeCustomerId,
  normalizeCustomerListLimit,
  type CreateCustomerInput,
  type Customer,
  type CustomerServiceOptions,
} from "./customers.js";
export {
  CUSTOMER_DETAIL_PATH,
  CUSTOMER_LIST_PATH,
  registerCustomerRoutes,
  type CustomerRoutesDeps,
} from "./routes.js";
