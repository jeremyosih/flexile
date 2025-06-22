# frozen_string_literal: true

class DeleteInvoice
    INVOICE_STATUSES_THAT_DENY_DELETION = Invoice::PAID_OR_PAYING_STATES + [Invoice::FAILED, Invoice::PROCESSING]

    def initialize(invoice:, deleted_by:)
      @invoice = invoice
      @deleted_by = deleted_by
    end

    def perform
      invoice.with_lock do
        return unless can_delete?

        # Clean up related records
        invoice.invoice_approvals.destroy_all
        invoice.invoice_line_items.destroy_all
        invoice.invoice_expenses.destroy_all

        # Remove from QuickBooks if integrated
        invoice.integration_records.each(&:mark_deleted!)

        invoice.destroy!
      end
    end

    private
      attr_reader :invoice, :deleted_by

      def can_delete?
        !invoice.status.in?(INVOICE_STATUSES_THAT_DENY_DELETION)
      end
  end