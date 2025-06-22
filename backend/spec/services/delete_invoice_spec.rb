# frozen_string_literal: true

RSpec.describe DeleteInvoice do
  let(:invoice) { create(:invoice, status: Invoice::RECEIVED) }
  let(:deleted_by) { create(:user) }

  subject(:service) { described_class.new(invoice: invoice, deleted_by: deleted_by) }

  describe "#perform" do
    describe "successful deletion" do
      before do
        create_list(:invoice_approval, 2, invoice: invoice)
        create(:invoice_line_item, invoice: invoice)  # Factory creates 1, this creates another = 2 total
        create(:invoice_expense, invoice: invoice)
        create(:integration_record, integratable: invoice)
      end

      it "destroys the invoice" do
        expect { service.perform }.to change { Invoice.count }.by(-1)
      end

      it "destroys associated invoice_approvals" do
        expect { service.perform }.to change { InvoiceApproval.count }.by(-2)
      end

      it "destroys associated invoice_line_items" do
        expect { service.perform }.to change { InvoiceLineItem.count }.by(-2)
      end

      it "destroys associated invoice_expenses" do
        expect { service.perform }.to change { InvoiceExpense.count }.by(-1)
      end

      it "marks integration records as deleted" do
        service.perform
        expect(invoice.integration_records.first.reload).to be_deleted
      end
    end

    describe "status validation" do
      context "when invoice status allows deletion" do
        [Invoice::RECEIVED, Invoice::APPROVED].each do |status|
          context "when status is #{status}" do
            let(:invoice) { create(:invoice, status: status) }

            it "performs deletion" do
              invoice # Create the invoice first
              expect { service.perform }.to change { Invoice.count }.by(-1)
            end
          end
        end
      end

      context "when invoice status denies deletion" do
        [Invoice::PAYMENT_PENDING, Invoice::PROCESSING, Invoice::PAID, Invoice::FAILED].each do |status|
          context "when status is #{status}" do
            let(:invoice) { create(:invoice, status: status) }

            it "does not delete the invoice" do
              invoice # Create the invoice first
              expect { service.perform }.not_to change { Invoice.count }
            end
          end
        end
      end
    end

    describe "with locking" do
      it "uses database locking during deletion" do
        expect(invoice).to receive(:with_lock).and_call_original
        service.perform
      end
    end

    context "when invoice cannot be deleted" do
      let(:invoice) { create(:invoice, status: Invoice::PAID) }

      it "returns early without performing deletion" do
        expect(invoice.invoice_approvals).not_to receive(:destroy_all)
        expect(invoice).not_to receive(:destroy!)
        service.perform
      end
    end
  end
end
