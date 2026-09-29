import { BucketTaskListPage } from "../components/gtd/BucketTaskListPage";

export const InboxPage = () => (
  <BucketTaskListPage bucket="inbox" i18nPrefix="inbox" quickAdd pageSize={40} />
);
