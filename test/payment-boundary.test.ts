import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentOperatorGuard } from '../src/modules/payment/payment-operator.guard';
import { MoneySerializationInterceptor, serializeMoney } from '../src/modules/payment/money-serialization.interceptor';
import { PaymentController } from '../src/modules/payment/payment.controller';
import { PaymentService } from '../src/modules/payment/payment.service';
import { AuthGuard } from '@nestjs/passport';

function context(headers: any) { const request: any = { headers }; return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as any }; }
test('money-out approval requires independent operator credential and identified reviewer', () => {
  const old = process.env.PAYMENT_OPERATOR_TOKEN;
  const guard = new PaymentOperatorGuard();
  try {
    delete process.env.PAYMENT_OPERATOR_TOKEN;
    assert.throws(() => guard.canActivate(context({}).context), ServiceUnavailableException);
    process.env.PAYMENT_OPERATOR_TOKEN = 'ephemeral-operator-test-token-1234567890';
    for (const headers of [{}, { authorization: 'Bearer a.customer.jwt', 'x-payment-operator': 'reviewer-1' },
      { authorization: 'Bearer ' + process.env.PAYMENT_OPERATOR_TOKEN },
      { authorization: 'Bearer ' + process.env.PAYMENT_OPERATOR_TOKEN, 'x-payment-operator': 'invalid\nreviewer' }]) {
      assert.throws(() => guard.canActivate(context(headers).context), ForbiddenException);
    }
    const valid = context({ authorization: 'Bearer ' + process.env.PAYMENT_OPERATOR_TOKEN, 'x-payment-operator': 'reviewer-1' });
    assert.equal(guard.canActivate(valid.context), true);
    assert.equal(valid.request.paymentOperator, 'reviewer-1');
  } finally { if (old === undefined) delete process.env.PAYMENT_OPERATOR_TOKEN; else process.env.PAYMENT_OPERATOR_TOKEN = old; }
});

test('cent JSON strings preserve 64-bit precision without modifying Date or original objects', () => {
  const date = new Date('2026-10-08T00:00:00Z');
  const source = { amountCents: 9007199254740993n, negatives: [-2n, null], date };
  const result = serializeMoney(source);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { amountCents: '9007199254740993', negatives: ['-2', null], date: date.toISOString() });
  assert.equal(result.date, date);
  assert.equal(source.amountCents, 9007199254740993n);
});

test('HTTP payment callback receives exact raw bytes, and cent amounts serialize in authenticated responses', async () => {
  const bytes = Buffer.from('{\n  "resource": { "ciphertext": "fictional" }, "id": "notification-test"\n}');
  let handled = 0;
  const service = {
    handleWechatCallback: async (raw: Buffer, headers: any) => {
      assert.ok(Buffer.isBuffer(raw)); assert.deepEqual(raw, bytes); assert.equal(headers['wechatpay-serial'], 'test-key-id');
      handled++; return { code: 'SUCCESS', message: '成功' };
    },
    getIncomeRecords: async () => ({ success: true, data: { balanceCents: 9007199254740993n, availableCents: 1n } }),
  };
  const module = await Test.createTestingModule({ controllers: [PaymentController], providers: [{ provide: PaymentService, useValue: service }] })
    .overrideGuard(AuthGuard('jwt')).useValue({ canActivate(ctx: any) { ctx.switchToHttp().getRequest().user = { id: 'fictional-angel', userType: 'angel' }; return true; } }).compile();
  const app = module.createNestApplication({ rawBody: true, logger: false });
  app.setGlobalPrefix('api'); app.useGlobalInterceptors(new MoneySerializationInterceptor());
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const notify = await fetch(base + '/api/payment/notify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Wechatpay-Serial': 'test-key-id' }, body: bytes });
    assert.equal(notify.status, 200); assert.equal(handled, 1);
    const income = await fetch(base + '/api/payment/income');
    assert.equal(income.status, 200);
    assert.deepEqual(await income.json(), { success: true, data: { balanceCents: '9007199254740993', availableCents: '1' } });
  } finally { await app.close(); }
});
