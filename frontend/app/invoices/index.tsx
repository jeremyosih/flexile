import { CurrencyDollarIcon } from "@heroicons/react/20/solid";
import { useMutation } from "@tanstack/react-query";
import React, { useState } from "react";
import MutationButton from "@/components/MutationButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentCompany, useCurrentUser } from "@/global";
import type { RouterOutput } from "@/trpc";
import { trpc } from "@/trpc/client";
import { request } from "@/utils/request";
import { approve_company_invoices_path, reject_company_invoices_path } from "@/utils/routes";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { CheckCircle } from "lucide-react";

type Invoice = RouterOutput["invoices"]["list"][number] | RouterOutput["invoices"]["get"];
export const EDITABLE_INVOICE_STATES: Invoice["status"][] = ["received", "rejected"];

export const useAreTaxRequirementsMet = () => {
  const company = useCurrentCompany();

  return (invoice: Invoice) =>
    !company.flags.includes("irs_tax_forms") || !!invoice.contractor.user.complianceInfo?.taxInformationConfirmedAt;
};

export const useCanSubmitInvoices = () => {
  const user = useCurrentUser();
  const company = useCurrentCompany();
  const { data: documents } = trpc.documents.list.useQuery(
    { companyId: company.id, userId: user.id, signable: true },
    { enabled: !!user.roles.worker },
  );
  const { data: contractorInfo } = trpc.users.getContractorInfo.useQuery(
    { companyId: company.id },
    { enabled: !!user.roles.worker },
  );
  const unsignedContractId = documents?.[0]?.id;
  const hasLegalDetails = user.address.street_address && !!user.taxInformationConfirmedAt;
  const contractSignedElsewhere = contractorInfo?.contractSignedElsewhere ?? false;

  return {
    unsignedContractId: contractSignedElsewhere ? null : unsignedContractId,
    hasLegalDetails,
    canSubmitInvoices: (contractSignedElsewhere || !unsignedContractId) && hasLegalDetails,
  };
};

export const Address = ({
  address,
}: {
  address: Pick<RouterOutput["invoices"]["get"], "streetAddress" | "city" | "zipCode" | "state" | "countryCode">;
}) => (
  <>
    {address.streetAddress}
    <br />
    {address.city}
    <br />
    {address.zipCode}
    {address.state ? `, ${address.state}` : null}
    <br />
    {address.countryCode ? new Intl.DisplayNames(["en"], { type: "region" }).of(address.countryCode) : null}
  </>
);

export const LegacyAddress = ({
  address,
}: {
  address: {
    street_address: string | null;
    city: string | null;
    zip_code: string | null;
    state: string | null;
    country: string | null;
    country_code: string | null;
  };
}) => (
  <>
    {address.street_address}
    <br />
    {address.city}
    <br />
    {address.zip_code}
    {address.state ? `, ${address.state}` : null}
    <br />
    {address.country}
  </>
);

const useIsApprovedByCurrentUser = () => {
  const user = useCurrentUser();
  return (invoice: Invoice) => invoice.approvals.some((approval) => approval.approver.id === user.id);
};

export function useIsActionable() {
  const isPayable = useIsPayable();
  const isApprovedByCurrentUser = useIsApprovedByCurrentUser();

  return (invoice: Invoice) =>
    isPayable(invoice) || (!isApprovedByCurrentUser(invoice) && ["received", "approved"].includes(invoice.status));
}

export function useIsPayable() {
  const company = useCurrentCompany();
  const isApprovedByCurrentUser = useIsApprovedByCurrentUser();

  return (invoice: Invoice) =>
    invoice.status === "failed" ||
    (["received", "approved"].includes(invoice.status) &&
      !invoice.requiresAcceptanceByPayee &&
      company.requiredInvoiceApprovals - invoice.approvals.length <= (isApprovedByCurrentUser(invoice) ? 0 : 1));
}

export const useApproveInvoices = (onSuccess?: () => void) => {
  const utils = trpc.useUtils();
  const company = useCurrentCompany();

  return useMutation({
    mutationFn: async ({ approve_ids, pay_ids }: { approve_ids?: string[]; pay_ids?: string[] }) => {
      await request({
        method: "PATCH",
        url: approve_company_invoices_path(company.id),
        accept: "json",
        jsonData: { approve_ids, pay_ids },
        assertOk: true,
      });
    },
    onSuccess: () => {
      setTimeout(() => {
        void utils.invoices.list.invalidate({ companyId: company.id });
        onSuccess?.();
      }, 500);
    },
  });
};

export const ApproveButton = ({ invoice, onApprove }: { invoice: Invoice; onApprove?: () => void }) => {
  const company = useCurrentCompany();
  const approveInvoices = useApproveInvoices(onApprove);
  const pay = useIsPayable()(invoice);
  const taxRequirementsMet = useAreTaxRequirementsMet();

  return (
    <MutationButton
      mutation={approveInvoices}
      param={{ [pay ? "pay_ids" : "approve_ids"]: [invoice.id] }}
      successText={pay ? "Payment sent!" : "Approved!"}
      loadingText={pay ? "Sending payment..." : "Approving..."}
      disabled={!!pay && (!company.completedPaymentMethodSetup || !taxRequirementsMet(invoice))}
    >
      {pay ? (
        <>
          <CurrencyDollarIcon className="size-4" /> Pay now
        </>
      ) : (
        "Approve"
      )}
    </MutationButton>
  );
};

export const ApproveContextMenuButton = ({ invoice, onClick }: { invoice: Invoice; onClick: () => void }) => {
  const company = useCurrentCompany();
  const taxRequirementsMet = useAreTaxRequirementsMet();
  const pay = useIsPayable()(invoice);

  return (
    <ContextMenuItem
      disabled={!!pay && (!company.completedPaymentMethodSetup || !taxRequirementsMet(invoice))}
      onClick={onClick}
    >
      {pay ? (
        <>
          <CurrencyDollarIcon className="size-4" /> Pay now
        </>
      ) : (
        <>
          <CheckCircle className="size-4" />
          Approve
        </>
      )}
    </ContextMenuItem>
  );
};

export const useRejectInvoices = (onSuccess?: () => void) => {
  const utils = trpc.useUtils();
  const company = useCurrentCompany();

  return useMutation({
    mutationFn: async (params: { ids: string[]; reason: string }) => {
      await request({
        method: "PATCH",
        url: reject_company_invoices_path(company.id),
        accept: "json",
        jsonData: params,
      });
      await utils.invoices.list.invalidate({ companyId: company.id });
    },
    onSuccess: () => onSuccess?.(),
  });
};

export const RejectModal = ({
  open,
  ids,
  onClose,
  onReject,
}: {
  open: boolean;
  ids: string[];
  onClose: () => void;
  onReject?: () => void;
}) => {
  const rejectInvoices = useRejectInvoices(() => {
    onReject?.();
    onClose();
  });
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject invoice?</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="reject-reason">Explain why the invoice was rejected and how to fix it (optional)</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            No, cancel
          </Button>
          <MutationButton mutation={rejectInvoices} param={{ ids, reason }} loadingText="Rejecting...">
            Yes, reject
          </MutationButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
