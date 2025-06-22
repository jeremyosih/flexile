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
      await expect(page.getByLabel("Hours worked")).toBeVisible();
      await expect(page.getByText("Total amount$0")).toBeVisible();
      await expect(page.locator("header").getByRole("link", { name: "New invoice" })).toBeVisible();
    });
  });

  const sharedInvoiceTests = (
    testContext = test,
    setup: () => Promise<{
      company: Company;
      adminUser: User;
      companyContractor: CompanyContractorWithUser;
      totalMinutes: number | null;
      expectedHours: string;
    }>,
  ) => {
    let company: Company;
    let adminUser: User;
    let companyContractor: CompanyContractorWithUser;
    let totalMinutes: number | null;
    let expectedHours: string;
    let targetInvoice: Invoice;

    const getInvoices = () => db.query.invoices.findMany({ where: eq(invoices.companyId, company.id) });

    const countInvoiceApprovals = async () => {
      const result = await db
        .select({ count: sql`count(*)` })
        .from(invoiceApprovals)
        .innerJoin(invoices, eq(invoiceApprovals.invoiceId, invoices.id))
        .where(eq(invoices.companyId, company.id));

      return Number(result[0]?.count || 0);
    };

    let targetInvoiceRowSelector: Record<string, string>;
    testContext.describe("shared invoices tests", () => {
      testContext.beforeEach(async () => {
        ({ company, adminUser, companyContractor, totalMinutes, expectedHours } = await setup());

        ({ invoice: targetInvoice } = await invoicesFactory.create({
          companyId: company.id,
          companyContractorId: companyContractor.id,
          totalAmountInUsdCents: BigInt(60_00),
          totalMinutes,
        }));

        assert(companyContractor.user.legalName !== null);

        targetInvoiceRowSelector = {
          Contractor: companyContractor.user.legalName,
          "Sent on": format(targetInvoice.invoiceDate, "MMM d, yyyy"),
          Hours: expectedHours,
          Amount: "$60",
        };
      });

      testContext.describe("approving and paying invoices", () => {
        testContext.beforeEach(async () => {
          const { invoice: anotherInvoice } = await invoicesFactory.create({
            companyId: company.id,
            totalAmountInUsdCents: BigInt(75_00),
            totalMinutes: 120,
          });
          const anotherInvoiceUser = await db.query.users.findFirst({
            where: eq(users.id, anotherInvoice.userId),
          });
          assert(anotherInvoiceUser !== undefined);
          assert(anotherInvoiceUser.legalName !== null);
        });

        testContext("allows approving an invoice", async ({ page }) => {
          await login(page, adminUser);
          await page.getByRole("link", { name: "Invoices" }).click();

          const targetInvoiceRow = await findRequiredTableRow(page, targetInvoiceRowSelector);

          await expect(targetInvoiceRow.getByText(companyContractor.role)).toBeVisible();
          await targetInvoiceRow.getByRole("button", { name: "Approve" }).click();
          await expect(targetInvoiceRow.getByText("Approved!")).toBeVisible();
          const approvalButton = targetInvoiceRow.getByText("Awaiting approval (1/2)");
          await expect(page.getByRole("link", { name: "Invoices" }).getByRole("status")).toContainText("1");

          const updatedTargetInvoice = await db.query.invoices.findFirst({
            where: eq(invoices.id, targetInvoice.id),
            with: {
              approvals: true,
            },
          });
          expect(updatedTargetInvoice?.status).toBe("approved");
          expect(updatedTargetInvoice?.approvals.length).toBe(1);

          const approvedTime = updatedTargetInvoice?.approvals[0]?.approvedAt;
          assert(approvedTime !== undefined);
          await expect(approvalButton).toHaveTooltip(
            `Approved by you on ${format(approvedTime, "MMM d, yyyy, h:mm a")}`,
          );
        });

        testContext("allows approving multiple invoices", async ({ page }) => {
          await login(page, adminUser);
          await page.getByRole("link", { name: "Invoices" }).click();

          await page.locator("th").getByLabel("Select all").check();
          await expect(page.getByText("2 selected")).toBeVisible();

          await page.getByRole("button", { name: "Approve selected invoices" }).click();

          // TODO missing check - need to verify ChargeConsolidatedInvoiceJob not enqueued

          await withinModal(
            async (modal) => {
              await expect(modal.getByText("$60")).toHaveCount(1);
              await expect(modal.getByText("$75")).toHaveCount(1);
              await modal.getByRole("button", { name: "Yes, proceed" }).click();
            },
            { page },
          );

          await expect(page.getByRole("dialog")).not.toBeVisible();
          expect(await countInvoiceApprovals()).toBe(2);

          const pendingInvoices = await db.$count(
            invoices,
            and(eq(invoices.companyId, company.id), not(eq(invoices.status, "approved"))),
          );
          expect(pendingInvoices).toBe(0);
        });

        testContext("allows approving an invoice that requires additional approvals", async ({ page }) => {
          await db.update(companies).set({ requiredInvoiceApprovalCount: 3 }).where(eq(companies.id, company.id));
          await db.update(invoices).set({ status: "approved" }).where(eq(invoices.id, targetInvoice.id));
          await invoiceApprovalsFactory.create({ invoiceId: targetInvoice.id });

          await login(page, adminUser);
          await page.getByRole("link", { name: "Invoices" }).click();

          const rowSelector = {
            ...targetInvoiceRowSelector,
            Status: "Awaiting approval (1/3)",
          };
          const invoiceRow = await findRequiredTableRow(page, rowSelector);
          await expect(invoiceRow.getByText(companyContractor.role)).toBeVisible();

          const invoiceApprovalsCountBefore = await countInvoiceApprovals();
          await invoiceRow.getByRole("button", { name: "Approve" }).click();

          assert(companyContractor.user.legalName !== null);
          await expect(invoiceRow.getByText("Approved!")).toBeVisible();

          expect(await countInvoiceApprovals()).toBe(invoiceApprovalsCountBefore + 1);

          const updatedInvoice = await db.query.invoices.findFirst({
            where: eq(invoices.id, targetInvoice.id),
          });
          expect(updatedInvoice?.status).toBe("approved");

          await page.waitForTimeout(1000);
          const approvedInvoiceSelector = {
            ...targetInvoiceRowSelector,
            Status: "Awaiting approval (2/3)",
          };
          await expect(page.getByText(companyContractor.user.legalName)).toBeVisible();
          const approvedInvoiceRow = await findRequiredTableRow(page, approvedInvoiceSelector);
          await expect(approvedInvoiceRow.getByText(companyContractor.role)).toBeVisible();
        });

        testContext.describe("with sufficient Flexile account balance", () => {
          testContext(
            "allows approving invoices and paying invoices awaiting final approval immediately",
            async ({ page }) => {
              const { user: anotherAdminUser } = await usersFactory.create();
              await companyAdministratorsFactory.create({
                companyId: company.id,
                userId: anotherAdminUser.id,
              });
              const { invoice: invoice3 } = await invoicesFactory.create({
                companyId: company.id,
                companyContractorId: companyContractor.id,
                totalAmountInUsdCents: 75_00n,
              });
              await invoiceApprovalsFactory.create({
                invoiceId: invoice3.id,
                approverId: anotherAdminUser.id,
              });
              await db.update(invoices).set({ status: "approved" }).where(eq(invoices.id, invoice3.id));

              const { invoice: invoice4 } = await invoicesFactory.create({
                companyId: company.id,
                companyContractorId: companyContractor.id,
                totalAmountInUsdCents: 75_00n,
              });
              await invoiceApprovalsFactory.create({
                invoiceId: invoice4.id,
                approverId: anotherAdminUser.id,
              });
              await db.update(invoices).set({ status: "approved" }).where(eq(invoices.id, invoice4.id));

              await login(page, adminUser);
              await page.getByRole("link", { name: "Invoices" }).click();

              await page.locator("th").getByLabel("Select all").check();
              await expect(page.getByText("4 selected")).toBeVisible();
              await page.getByRole("button", { name: "Approve selected invoices" }).click();

              const invoiceApprovalsCountBefore = await countInvoiceApprovals();
              const consolidatedInvoicesCountBefore = await db.$count(
                consolidatedInvoices,
                eq(consolidatedInvoices.companyId, company.id),
              );

              await withinModal(
                async (modal) => {
                  await expect(modal.getByText("You are paying $150 now.")).toBeVisible();
                  await expect(modal.getByText("$75")).toHaveCount(3); // partially-approved invoices being paid, plus one received invoice being approved
                  await expect(modal.getByText("$60")).toHaveCount(1); // received invoice being approved
                  await modal.getByRole("button", { name: "Yes, proceed" }).click();
                },
                { page },
              );
              await expect(page.getByRole("dialog")).not.toBeVisible();

              const consolidatedInvoicesCountAfter = await db.$count(
                consolidatedInvoices,
                eq(consolidatedInvoices.companyId, company.id),
              );
              expect(await countInvoiceApprovals()).toBe(invoiceApprovalsCountBefore + 4);
              expect(consolidatedInvoicesCountAfter).toBe(consolidatedInvoicesCountBefore + 1);

              const updatedInvoices = await getInvoices();
              const expectedPaidInvoices = [invoice3.id, invoice4.id];
              for (const invoice of updatedInvoices) {
                expect(invoice.status).toBe(expectedPaidInvoices.includes(invoice.id) ? "payment_pending" : "approved");
              }
            },
          );
        });
      });

      testContext.describe("rejecting invoices", () => {
        testContext.beforeEach(async () => {
          await invoicesFactory.create({
            companyId: company.id,
            companyContractorId: companyContractor.id,
          });
        });

        testContext("allows rejecting invoices without a reason", async ({ page }) => {
          await login(page, adminUser);
          await page.getByRole("link", { name: "Invoices" }).click();

          await page.locator("th").getByLabel("Select all").check();
          await expect(page.getByText("2 selected")).toBeVisible();
          await page.getByRole("button", { name: "Reject selected invoices" }).click();

          await page.getByRole("button", { name: "Yes, reject" }).click();
          await expect(page.getByText("Rejected")).toHaveCount(2);

          const updatedInvoices = await getInvoices();
          expect(updatedInvoices.length).toBe(2);
          expect(
            updatedInvoices.every((invoice) => invoice.status === "rejected" && invoice.rejectionReason === null),
          ).toBe(true);
        });

        testContext("allows rejecting invoices with a reason", async ({ page }) => {
          await login(page, adminUser);
          await page.getByRole("link", { name: "Invoices" }).click();

          await page.locator("th").getByLabel("Select all").check();
          await expect(page.getByText("2 selected")).toBeVisible();
          await page.getByRole("button", { name: "Reject selected invoices" }).click();

          await page.getByLabel("Explain why the invoice").fill("Invoice issue date mismatch");
          await page.getByRole("button", { name: "Yes, reject" }).click();
          await expect(page.getByText("Rejected")).toHaveCount(2);

          const updatedInvoices = await getInvoices();
          expect(updatedInvoices.length).toBe(2);
          expect(
            updatedInvoices.every(
              (invoice) => invoice.status === "rejected" && invoice.rejectionReason === "Invoice issue date mismatch",
            ),
          ).toBe(true);
        });
      });
    });
  };

  test.describe("when company worker has an hourly rate", () => {
    const setup = async () => {
      const { company, user: adminUser } = await setupCompany();
      const { companyContractor } = await companyContractorsFactory.create({ companyId: company.id });

      const contractorUser = await db.query.users.findFirst({
        where: eq(users.id, companyContractor.userId),
      });
      assert(contractorUser !== undefined);

      return {
        company,
        adminUser,
        companyContractor: { ...companyContractor, user: contractorUser },
        totalMinutes: 60,
        expectedHours: "01:00",
      };
    };

    sharedInvoiceTests(test, setup);
  });

  test.describe("when company worker has a project-based rate", () => {
    const setup = async () => {
      const { company, user: adminUser } = await setupCompany();
      const { companyContractor } = await companyContractorsFactory.createProjectBased({
        companyId: company.id,
      });

      const contractorUser = await db.query.users.findFirst({
        where: eq(users.id, companyContractor.userId),
      });
      assert(contractorUser !== undefined);

      return {
        company,
        adminUser,
        companyContractor: {
          ...companyContractor,
          user: contractorUser,
        },
        totalMinutes: null,
        expectedHours: "N/A",
      };
    };

    sharedInvoiceTests(test, setup);
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
