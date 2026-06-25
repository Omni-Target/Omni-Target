const fs = require('fs');

// 1. Create SQL migration
fs.writeFileSync('supabase/scopes.sql', 'ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS shopify_scopes TEXT;\n');

// 2. Update shopify callback
let cbCode = fs.readFileSync('src/app/api/auth/shopify/callback/route.ts', 'utf8');
cbCode = cbCode.replace(
`      shopify_token_expires_at: tokenExpiresAt,
    };`,
`      shopify_token_expires_at: tokenExpiresAt,
      shopify_scopes: tokenData.scope,
    };`
);
fs.writeFileSync('src/app/api/auth/shopify/callback/route.ts', cbCode);

// 3. Update store/data/route.ts
let dataCode = fs.readFileSync('src/app/api/store/data/route.ts', 'utf8');
dataCode = dataCode.replace(
`      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
    });
  } catch (error) {`,
`      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
      needsReauthForOrders: !creditsRow?.shopify_scopes?.includes("read_all_orders"),
    });
  } catch (error) {`
);
fs.writeFileSync('src/app/api/store/data/route.ts', dataCode);

console.log('Done');
