const fs = require('fs');
let code = fs.readFileSync('src/app/dashboard/page.tsx', 'utf8');

// Update StoreDataResponse
const typeOld = `  credits_unlimited_until?: string | null;
}`;
const typeNew = `  credits_unlimited_until?: string | null;
  needsReauthForOrders?: boolean;
}`;
code = code.replace(typeOld, typeNew);

// Add state
const stateOld = `  const [connected, setConnected] = useState(false);`;
const stateNew = `  const [connected, setConnected] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);`;
code = code.replace(stateOld, stateNew);

// Set state in fetch
const fetchOld = `        setConnected(data.connected);
        if (data.connected && data.data) {`;
const fetchNew = `        setConnected(data.connected);
        if (data.needsReauthForOrders) {
          setNeedsReauth(true);
        }
        if (data.connected && data.data) {`;
code = code.replace(fetchOld, fetchNew);

// Same in the handleRefresh callback later down
const refreshOld = `        setConnected(data.connected);
        if (data.connected && data.data) {`;
const refreshNew = `        setConnected(data.connected);
        if (data.needsReauthForOrders) {
          setNeedsReauth(true);
        }
        if (data.connected && data.data) {`;
code = code.replace(refreshOld, refreshNew);

fs.writeFileSync('src/app/dashboard/page.tsx', code);
console.log('Updated state in dashboard');
