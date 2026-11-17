# Power BI report

The report imports the order-to-cash **views** in PostgreSQL, the same ones the dashboard reads, so the
two always agree.

| View | Grain | Use |
|---|---|---|
| `o2c_orders` | sales order | stage, delivered / invoiced / paid dates, cycle times, on-time flag |
| `o2c_open_receivables` | open customer line item | amount, due date, days overdue, ageing bucket |
| `o2c_dso` | currency | open AR, invoiced last 90 days, DSO |
| `customers` | customer | name, city, country |
| `sync_runs` | sync of one entity | freshness and failures |

## Steps

1. Create the read-only login: `psql "$DATABASE_URL" -v pw="'…'" -f powerbi/readonly_role.sql`.
2. In Power BI Desktop, choose **Get data → PostgreSQL database**:
   - Server `localhost` (Docker) or the Azure server name.
   - Database `orderloop`, **Import** mode.
   - Sign in as `powerbi`.

   On Azure, deploy with `OL_CLIENT_IP=<your IP>` so the firewall lets your machine in.
3. Select the five tables above.
4. Add the relationships, both many-to-one and single direction:
   - `o2c_orders[sold_to]` → `customers[customer]`
   - `o2c_open_receivables[customer]` → `customers[customer]`
5. Paste the measures from [`measures.dax`](measures.dax). Sort `bucket` by the `Bucket Order` column.
6. Build the pages:

| Page | Visuals |
|---|---|
| **Cash** | Cards: `DSO (90 d)`, `Open Receivables`, `Overdue Share`. Stacked bar: `Open Receivables` by `bucket`. Table: top customers by `Overdue Receivables`. |
| **Flow** | Funnel: `Orders` by `stage`. Line: `Avg Days to Pay` by order month. Cards: the three cycle-time measures and `On-time Delivery`. |
| **Customers** | Map: `Order Value` by `customers[city]`. Matrix: customer × `Orders`, `Paid Share`, `Avg Days to Pay`. |
| **Data health** | Table of `sync_runs` (latest per entity), with a card showing the most recent `started_at`. |

Schedule the dataset refresh (Power BI Service, through an on-premises data gateway or a cloud
connection to Azure PostgreSQL) to run after the hourly sync, for example at :10.
