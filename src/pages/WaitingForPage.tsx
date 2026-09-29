import { BucketTaskListPage } from "../components/gtd/BucketTaskListPage";

export const WaitingForPage = () => (
  <BucketTaskListPage bucket="waiting_for" i18nPrefix="waiting" quickAdd contextFilter />
);
