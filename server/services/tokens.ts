import { db } from "../db";
import { decrypt, encrypt } from "./crypto";

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
}

/** Encrypted token storage interface; swap the implementation for a KMS/secret-manager backed store. */
export interface TokenStore {
  get(siteId: string): Promise<StoredTokens | undefined>;
  save(siteId: string, tokens: StoredTokens): Promise<void>;
  purge(siteId: string): Promise<void>;
}

class DbTokenStore implements TokenStore {
  async get(siteId: string): Promise<StoredTokens | undefined> {
    const row = db.get<{ access_token_enc: string; refresh_token_enc: string }>(
      `SELECT access_token_enc, refresh_token_enc FROM installations WHERE site_id = ? AND uninstalled_at IS NULL`,
      [siteId]
    );
    if (!row || !row.access_token_enc) return undefined;
    return { accessToken: decrypt(row.access_token_enc), refreshToken: row.refresh_token_enc ? decrypt(row.refresh_token_enc) : undefined };
  }
  async save(siteId: string, tokens: StoredTokens): Promise<void> {
    db.run(`UPDATE installations SET access_token_enc = ?, refresh_token_enc = ? WHERE site_id = ?`, [
      encrypt(tokens.accessToken),
      tokens.refreshToken ? encrypt(tokens.refreshToken) : "",
      siteId,
    ]);
  }
  async purge(siteId: string): Promise<void> {
    db.run(`UPDATE installations SET access_token_enc = '', refresh_token_enc = '' WHERE site_id = ?`, [siteId]);
  }
}

export const tokenStore: TokenStore = new DbTokenStore();
