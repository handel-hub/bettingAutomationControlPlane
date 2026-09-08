// @ts-check
import { 
  InMemoryAccountsRepo, 
  InMemoryConfigRepo, 
  InMemoryBillingRepo, 
  InMemorySettingsRepo, 
  InMemoryNotificationsRepo 
} from './in-memory/InMemoryRepos.mjs';

class RepositoryFactory {
  constructor() {
    this.accountsRepo = new InMemoryAccountsRepo();
    this.configRepo = new InMemoryConfigRepo();
    this.billingRepo = new InMemoryBillingRepo();
    this.settingsRepo = new InMemorySettingsRepo();
    this.notificationsRepo = new InMemoryNotificationsRepo();
  }

  getAccountsRepo() { return this.accountsRepo; }
  getConfigRepo() { return this.configRepo; }
  getBillingRepo() { return this.billingRepo; }
  getSettingsRepo() { return this.settingsRepo; }
  getNotificationsRepo() { return this.notificationsRepo; }
}

export const repositoryFactory = new RepositoryFactory();
