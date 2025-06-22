import { db } from "@test/db";
import { companiesFactory } from "@test/factories/companies";
import { companyAdministratorsFactory } from "@test/factories/companyAdministrators";
import { companyContractorsFactory } from "@test/factories/companyContractors";
import { companyStripeAccountsFactory } from "@test/factories/companyStripeAccounts";
import { invoiceApprovalsFactory } from "@test/factories/invoiceApprovals";
import { invoicesFactory } from "@test/factories/invoices";
import { usersFactory } from "@test/factories/users";
import { login } from "@test/helpers/auth";
import { findRequiredTableRow } from "@test/helpers/matchers";
import { expect, test, withinModal } from "@test/index";
import { format } from "date-fns";
import { and, eq, not, sql } from "drizzle-orm";
import { companies, consolidatedInvoices, invoiceApprovals, invoices, users } from "@/db/schema";
import { assert } from "@/utils/assert";

type Company = Awaited<ReturnType<typeof companiesFactory.create>>["company"];
type User = Awaited<ReturnType<typeof usersFactory.create>>["user"];
type CompanyContractor = Awaited<ReturnType<typeof companyContractorsFactory.create>>["companyContractor"];
type CompanyContractorWithUser = CompanyContractor & {
  user: User;
};
type Invoice = Awaited<ReturnType<typeof invoicesFactory.create>>["invoice"];

test.describe("Invoices admin flow", () => {
  const setupCompany = async ({ trusted = true }: { trusted?: boolean } = {}) => {
    const { company } = await companiesFactory.create({ isTrusted: trusted, requiredInvoiceApprovalCount: 2 });
    const { administrator } = await companyAdministratorsFactory.create({ companyId: company.id });
    const user = await db.query.users.findFirst({ where: eq(users.id, administrator.userId) });
    assert(user !== undefined);
    return { company, user };
  };

  const countInvoiceApprovals = (companyId: bigint) =>
    db.$count(
      db
        .select()
        .from(invoiceApprovals)
        .innerJoin(invoices, eq(invoiceApprovals.invoiceId, invoices.id))
        .where(eq(invoices.companyId, companyId)),
    );

  test("allows searching invoices by contractor name", async ({ page }) => {
    const { company, user: adminUser } = await setupCompany();

    const { companyContractor } = await companyContractorsFactory.create({
      companyId: company.id,
      role: "SearchTest Contractor",
    });
    const contractorUser = await db.query.users.findFirst({
      where: eq(users.id, companyContractor.userId),
    });
    assert(contractorUser !== undefined);

    await invoicesFactory.create({
      companyId: company.id,
      companyContractorId: companyContractor.id,
      totalAmountInUsdCents: BigInt(100_00),
    });

    await login(page, adminUser);
    await page.getByRole("link", { name: "Invoices" }).click();

    const searchInput = page.getByPlaceholder("Search by Contractor...");
    await expect(searchInput).toBeVisible();

    await searchInput.fill(contractorUser.legalName || "");

    await expect(page.getByRole("row").filter({ hasText: contractorUser.legalName || "" })).toBeVisible();
  });

  test.describe("account statuses", () => {
    test("when payment method setup is incomplete, it shows the correct status message", async ({ page }) => {
      const { company, user } = await setupCompany();
      await companyStripeAccountsFactory.createProcessing({ companyId: company.id });
      await invoicesFactory.create({ companyId: company.id });

      await login(page, user);

      await expect(page.getByRole("link", { name: "Invoices" })).toBeVisible({ timeout: 30000 });
      await page.getByRole("link", { name: "Invoices" }).click();
      await expect(page.getByText("Bank account setup incomplete.")).toBeVisible();
    });

    test("when payment method setup is complete but company is not trusted and has invoices, shows the correct status message", async ({
      page,
    }) => {
      const { company, user } = await setupCompany({ trusted: false });
      await companyStripeAccountsFactory.create({ companyId: company.id });
      await invoicesFactory.create({ companyId: company.id });

      await login(page, user);

      await expect(page.getByRole("link", { name: "Invoices" })).toBeVisible({ timeout: 30000 });
      await page.getByRole("link", { name: "Invoices" }).click();
      await expect(page.getByText("Payments to contractors may take up to 10 business days to process.")).toBeVisible();
    });

    test("when payment method setup is complete but company is not trusted and has no invoices, does not show the status message", async ({
      page,
    }) => {
      const { user } = await setupCompany({ trusted: false });
      await login(page, user);

      await page.getByRole("link", { name: "Invoices" }).click();
      await expect(page.getByText("Bank account setup incomplete.")).not.toBeVisible();
      await expect(
        page.getByText("Payments to contractors may take up to 10 business days to process."),
      ).not.toBeVisible();
    });

    test("when payment method setup is complete and company is trusted, does not show the status message", async ({
      page,
    }) => {
      const { company, user } = await setupCompany({ trusted: true });
      await companyStripeAccountsFactory.create({ companyId: company.id });
      await invoicesFactory.create({ companyId: company.id });

      await login(page, user);

      await page.getByRole("link", { name: "Invoices" }).click();
      await expect(page.getByText("Bank account setup incomplete.")).not.toBeVisible();
      await expect(
        page.getByText("Payments to contractors may take up to 10 business days to process."),
      ).not.toBeVisible();
    });

    test("loads successfully for alumni", async ({ page }) => {
      const { company } = await setupCompany();
      const { companyContractor } = await companyContractorsFactory.create({
        companyId: company.id,
        endedAt: new Date("2023-01-01"),
      });
      const contractorUser = await db.query.users.findFirst({
        where: eq(users.id, companyContractor.userId),
      });
      assert(contractorUser !== undefined);

      await login(page, contractorUser);
      await page.getByRole("link", { name: "Invoices" }).click();
      await expect(page.getByLabel("Hours / Qty")).toBeVisible();
      await expect(page.getByText("Total amount$60")).toBeVisible();
      await expect(page.locator("header").getByRole("link", { name: "New invoice" })).toBeVisible();
    });
  });

  test.describe("approving and paying invoices", () => {
    test("allows approving an invoice", async ({ page }) => {
      const { company, user: adminUser } = await setupCompany();
      const { invoice } = await invoicesFactory.create({ companyId: company.id });
      await login(page, adminUser);
      await page.getByRole("link", { name: "Invoices" }).click();

      const invoiceRow = page.locator("tbody tr").first();
      await invoiceRow.getByRole("button", { name: "Approve" }).click();
      await expect(invoiceRow).toContainText("Approved!");
      const approvalButton = invoiceRow.getByText("Awaiting approval (1/2)");
      await expect(page.getByRole("link", { name: "Invoices" }).getByRole("status")).not.toBeVisible();

      const updatedTargetInvoice = await db.query.invoices.findFirst({
        where: eq(invoices.id, invoice.id),
        with: { approvals: true },
      });
      expect(updatedTargetInvoice?.status).toBe("approved");
      expect(updatedTargetInvoice?.approvals.length).toBe(1);

      const approvedTime = updatedTargetInvoice?.approvals[0]?.approvedAt;
      assert(approvedTime !== undefined);
      await expect(approvalButton).toHaveTooltip(`Approved by you on ${format(approvedTime, "MMM d, yyyy, h:mm a")}`);
    });

    test("allows approving multiple invoices", async ({ page }) => {
      const { company, user: adminUser } = await setupCompany();
      await invoicesFactory.create({ companyId: company.id });
      await invoicesFactory.create({ companyId: company.id });
      await login(page, adminUser);
      await page.getByRole("link", { name: "Invoices" }).click();

      await page.locator("th").getByLabel("Select all").check();
      await expect(page.getByText("2 selected")).toBeVisible();

      await page.getByRole("button", { name: "Approve selected" }).click();

      await withinModal(
        async (modal) => {
          await expect(modal.getByText("$60")).toHaveCount(2);
          await modal.getByRole("button", { name: "Yes, proceed" }).click();
        },
        { page },
      );

      await expect(page.getByRole("dialog")).not.toBeVisible();
      expect(await countInvoiceApprovals(company.id)).toBe(2);

      const pendingInvoices = await db.$count(
        invoices,
        and(eq(invoices.companyId, company.id), not(eq(invoices.status, "approved"))),
      );
      expect(pendingInvoices).toBe(0);
    });

    test("allows approving an invoice that requires additional approvals", async ({ page }) => {
      const { company, user: adminUser } = await setupCompany();
      await db.update(companies).set({ requiredInvoiceApprovalCount: 3 }).where(eq(companies.id, company.id));
      const { invoice } = await invoicesFactory.create({ companyId: company.id, status: "approved" });
      await invoiceApprovalsFactory.create({ invoiceId: invoice.id });
      await login(page, adminUser);
      await page.getByRole("link", { name: "Invoices" }).click();

      const invoiceRow = page.locator("tbody tr").first();
      await expect(invoiceRow).toContainText("Awaiting approval (1/3)");
      const invoiceApprovalsCountBefore = await countInvoiceApprovals(company.id);
      await invoiceRow.getByRole("button", { name: "Approve" }).click();
      await expect(invoiceRow.getByText("Approved!")).toBeVisible();

      expect(await countInvoiceApprovals(company.id)).toBe(invoiceApprovalsCountBefore + 1);

      const updatedInvoice = await db.query.invoices.findFirst({
        where: eq(invoices.id, invoice.id),
      });
      expect(updatedInvoice?.status).toBe("approved");

      await page.waitForTimeout(1000);
      await expect(invoiceRow).toContainText("Awaiting approval (2/3)");
    });

    test.describe("with sufficient Flexile account balance", () => {
      test("allows approving invoices and paying invoices awaiting final approval immediately", async ({ page }) => {
        const { company, user: adminUser } = await setupCompany();
        await invoicesFactory.create({ companyId: company.id });
        await invoicesFactory.create({ companyId: company.id });
        const { invoice } = await invoicesFactory.create({
          companyId: company.id,
          totalAmountInUsdCents: 75_00n,
        });
        await invoiceApprovalsFactory.create({ invoiceId: invoice.id });
        await db.update(invoices).set({ status: "approved" }).where(eq(invoices.id, invoice.id));

        const { invoice: invoice2 } = await invoicesFactory.create({
          companyId: company.id,
          totalAmountInUsdCents: 75_00n,
        });
        await invoiceApprovalsFactory.create({ invoiceId: invoice2.id });
        await db.update(invoices).set({ status: "approved" }).where(eq(invoices.id, invoice2.id));

        await login(page, adminUser);
        await page.getByRole("link", { name: "Invoices" }).click();

        await page.locator("th").getByLabel("Select all").check();
        await expect(page.getByText("4 selected")).toBeVisible();
        await page.getByRole("button", { name: "Approve selected" }).click();

        const invoiceApprovalsCountBefore = await countInvoiceApprovals(company.id);
        const consolidatedInvoicesCountBefore = await db.$count(
          consolidatedInvoices,
          eq(consolidatedInvoices.companyId, company.id),
        );

        await withinModal(
          async (modal) => {
            await expect(modal.getByText("You are paying $150 now.")).toBeVisible();
            await expect(modal.getByText("$75")).toHaveCount(2);
            await expect(modal.getByText("$60")).toHaveCount(2);
            await modal.getByRole("button", { name: "Yes, proceed" }).click();
          },
          { page },
        );
        await expect(page.getByRole("dialog")).not.toBeVisible();

        const consolidatedInvoicesCountAfter = await db.$count(
          consolidatedInvoices,
          eq(consolidatedInvoices.companyId, company.id),
        );
        expect(await countInvoiceApprovals(company.id)).toBe(invoiceApprovalsCountBefore + 4);
        expect(consolidatedInvoicesCountAfter).toBe(consolidatedInvoicesCountBefore + 1);

        const updatedInvoices = await db.query.invoices.findMany({ where: eq(invoices.companyId, company.id) });
        const expectedPaidInvoices = [invoice.id, invoice2.id];
        for (const invoice of updatedInvoices) {
          expect(invoice.status).toBe(expectedPaidInvoices.includes(invoice.id) ? "payment_pending" : "approved");
        }
      });
    });
  });

  test.describe("rejecting invoices", () => {
    test("allows rejecting invoices without a reason", async ({ page }) => {
      const { company, user: adminUser } = await setupCompany();
      await invoicesFactory.create({ companyId: company.id });
      await invoicesFactory.create({ companyId: company.id });
      await login(page, adminUser);
      await page.getByRole("link", { name: "Invoices" }).click();

      await page.locator("th").getByLabel("Select all").check();
      await expect(page.getByText("2 selected")).toBeVisible();
      await page.getByRole("button", { name: "Reject selected" }).click();

      await page.getByRole("button", { name: "Yes, reject" }).click();
      await expect(page.getByText("Rejected")).toHaveCount(2);

      const updatedInvoices = await db.query.invoices.findMany({ where: eq(invoices.companyId, company.id) });
      expect(updatedInvoices.length).toBe(2);
      expect(
        updatedInvoices.every((invoice) => invoice.status === "rejected" && invoice.rejectionReason === null),
      ).toBe(true);
    });

    test("allows rejecting invoices with a reason", async ({ page }) => {
      const { company, user: adminUser } = await setupCompany();
      await invoicesFactory.create({ companyId: company.id });
      await invoicesFactory.create({ companyId: company.id });
      await login(page, adminUser);
      await page.getByRole("link", { name: "Invoices" }).click();

      await page.locator("th").getByLabel("Select all").check();
      await expect(page.getByText("2 selected")).toBeVisible();
      await page.getByRole("button", { name: "Reject selected" }).click();

      await page
        .getByLabel("Explain why the invoice was rejected and how to fix it (optional)")
        .fill("Invoice issue date mismatch");
      await page.getByRole("button", { name: "Yes, reject" }).click();
      await expect(page.getByText("Rejected")).toHaveCount(2);

      const updatedInvoices = await db.query.invoices.findMany({ where: eq(invoices.companyId, company.id) });
      expect(updatedInvoices.length).toBe(2);
      expect(
        updatedInvoices.every(
          (invoice) => invoice.status === "rejected" && invoice.rejectionReason === "Invoice issue date mismatch",
        ),
      ).toBe(true);
    });
  });
});

test.describe("Invoices contractor flow", () => {
  const setupCompany = async ({ trusted = true }: { trusted?: boolean } = {}) => {
    const { company } = await companiesFactory.create({ isTrusted: trusted, requiredInvoiceApprovalCount: 2 });
    const { administrator } = await companyAdministratorsFactory.create({ companyId: company.id });
    const user = await db.query.users.findFirst({ where: eq(users.id, administrator.userId) });
    assert(user !== undefined);
    return { company, user };
  };

  const setupCompanyAndContractor = async (isProjectBased = false) => {
    const { company, user: adminUser } = await setupCompany();
    const { companyContractor } = isProjectBased
      ? await companyContractorsFactory.createProjectBased({ companyId: company.id })
      : await companyContractorsFactory.create({ companyId: company.id });

    const contractorUser = await db.query.users.findFirst({
      where: eq(users.id, companyContractor.userId),
    });
    assert(contractorUser !== undefined);

    return {
      company,
      adminUser,
      companyContractor: { ...companyContractor, user: contractorUser },
    };
  };

  const sharedContractorTests = (
    testContext = test,
    setup: () => Promise<{
      company: Company;
      adminUser: User;
      companyContractor: CompanyContractorWithUser;
    }>,
  ) => {
    let company: Company;
    let companyContractor: CompanyContractorWithUser;

    const getInvoices = () => db.query.invoices.findMany({ where: eq(invoices.companyId, company.id) });

    testContext.describe("deleting invoices", () => {
      testContext.beforeEach(async () => {
        const setupResult = await setup();
        company = setupResult.company;
        companyContractor = setupResult.companyContractor;

        // Create invoices for deletion tests
        await invoicesFactory.create({
          companyId: company.id,
          companyContractorId: companyContractor.id,
          status: "received",
        });
        await invoicesFactory.create({
          companyId: company.id,
          companyContractorId: companyContractor.id,
          status: "received",
        });
      });

      testContext(
        "shows delete option in context menu for received invoices when logged in as contractor",
        async ({ page }) => {
          const contractorUser = companyContractor.user;
          await login(page, contractorUser);
          await page.getByRole("link", { name: "Invoices" }).click();

          assert(contractorUser.legalName !== null);

          // Right-click on the invoice row to open context menu
          const targetInvoiceRow = await findRequiredTableRow(page, {
            Status: "Awaiting approval",
          });

          await targetInvoiceRow.click({ button: "right" });
          await expect(page.getByRole("menuitem").filter({ hasText: "Delete" })).toBeVisible();
        },
      );

      testContext("does not show delete option for non-deletable invoices", async ({ page }) => {
        // Update invoice to paid status (non-deletable)
        const invoiceList = await getInvoices();
        const firstInvoice = invoiceList[0];
        assert(firstInvoice !== undefined);
        await db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, firstInvoice.id));

        const contractorUser = companyContractor.user;
        await login(page, contractorUser);
        await page.getByRole("link", { name: "Invoices" }).click();

        assert(contractorUser.legalName !== null);

        const targetInvoiceRow = await findRequiredTableRow(page, {
          Status: "Paid",
        });

        await targetInvoiceRow.click({ button: "right" });
        await expect(page.getByRole("menuitem").filter({ hasText: "Delete" })).not.toBeVisible();
      });

      testContext("allows contractor to delete invoice via selection actions", async ({ page }) => {
        const contractorUser = companyContractor.user;
        await login(page, contractorUser);
        await page.getByRole("link", { name: "Invoices" }).click();

        assert(contractorUser.legalName !== null);

        // Wait for table to load
        await expect(page.locator("tbody tr")).toHaveCount(2);

        // Select any deletable row by checkbox
        await page.locator("tbody tr").first().getByRole("checkbox").check();
        await page.getByRole("button", { name: "Delete selected invoices" }).click();
        await page.getByRole("button", { name: "Delete" }).click();

        // Wait for deletion to complete
        await expect(page.locator("tbody tr")).toHaveCount(1);

        const updatedInvoices = await getInvoices();
        expect(updatedInvoices.length).toBe(1);
      });
    });
  };

  test.describe("when company worker has an hourly rate", () => {
    const setup = async () => setupCompanyAndContractor(false);
    sharedContractorTests(test, setup);
  });

  test.describe("when company worker has a project-based rate", () => {
    const setup = async () => setupCompanyAndContractor(true);
    sharedContractorTests(test, setup);
  });
});
