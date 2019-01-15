import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';

import { filterAsync } from '../../../../../shared/filter-async';
import { AdjustmentType } from '../../../../../shared/generated-types';
import { ID } from '../../../../../shared/shared-types';
import { unique } from '../../../../../shared/unique';
import { RequestContext } from '../../../api/common/request-context';
import { idsAreEqual } from '../../../common/utils';
import { PromotionUtils } from '../../../config';
import { ConfigService } from '../../../config/config.service';
import { OrderLine, ProductVariant } from '../../../entity';
import { Order } from '../../../entity/order/order.entity';
import { Promotion } from '../../../entity/promotion/promotion.entity';
import { ShippingMethod } from '../../../entity/shipping-method/shipping-method.entity';
import { Zone } from '../../../entity/zone/zone.entity';
import { TaxRateService } from '../../services/tax-rate.service';
import { ZoneService } from '../../services/zone.service';
import { ShippingCalculator } from '../shipping-calculator/shipping-calculator';
import { TaxCalculator } from '../tax-calculator/tax-calculator';

@Injectable()
export class OrderCalculator {
    constructor(
        @InjectConnection() private connection: Connection,
        private configService: ConfigService,
        private zoneService: ZoneService,
        private taxRateService: TaxRateService,
        private taxCalculator: TaxCalculator,
        private shippingCalculator: ShippingCalculator,
    ) {}

    private readonly promotionUtils: PromotionUtils = {
        hasFacetValues: async (orderLine: OrderLine, facetValueIds: ID[]): Promise<boolean> => {
            const variant = await this.connection
                .getRepository(ProductVariant)
                .findOne(orderLine.productVariant.id, {
                    relations: ['product', 'product.facetValues', 'facetValues'],
                });
            if (!variant) {
                return false;
            }
            const allFacetValues = unique([...variant.facetValues, ...variant.product.facetValues], 'id');
            return facetValueIds.reduce(
                (result, id) => result && !!allFacetValues.find(fv => idsAreEqual(fv.id, id)),
                true,
            );
        },
    };

    /**
     * Applies taxes and promotions to an Order. Mutates the order object.
     */
    async applyPriceAdjustments(ctx: RequestContext, order: Order, promotions: Promotion[]): Promise<Order> {
        const { taxZoneStrategy } = this.configService.taxOptions;
        const zones = this.zoneService.findAll(ctx);
        const activeTaxZone = taxZoneStrategy.determineTaxZone(zones, ctx.channel, order);
        order.clearAdjustments();
        if (order.lines.length) {
            // First apply taxes to the non-discounted prices
            this.applyTaxes(ctx, order, activeTaxZone);
            // Then test and apply promotions
            await this.applyPromotions(order, promotions);
            // Finally, re-calculate taxes because the promotions may have
            // altered the unit prices, which in turn will alter the tax payable.
            this.applyTaxes(ctx, order, activeTaxZone);
            await this.applyShipping(ctx, order);
        } else {
            this.calculateOrderTotals(order);
        }
        return order;
    }

    /**
     * Applies the correct TaxRate to each OrderItem in the order.
     */
    private applyTaxes(ctx: RequestContext, order: Order, activeZone: Zone) {
        for (const line of order.lines) {
            line.clearAdjustments(AdjustmentType.TAX);

            const applicableTaxRate = this.taxRateService.getApplicableTaxRate(activeZone, line.taxCategory);
            const { price, priceIncludesTax, priceWithTax, priceWithoutTax } = this.taxCalculator.calculate(
                line.unitPrice,
                line.taxCategory,
                activeZone,
                ctx,
            );

            line.setUnitPriceIncludesTax(priceIncludesTax);
            line.setTaxRate(applicableTaxRate.value);

            if (!priceIncludesTax) {
                for (const item of line.items) {
                    item.pendingAdjustments = item.pendingAdjustments.concat(
                        applicableTaxRate.apply(item.unitPriceWithPromotions),
                    );
                }
            }
            this.calculateOrderTotals(order);
        }
    }

    /**
     * Applies any eligible promotions to each OrderItem in the order.
     */
    private async applyPromotions(order: Order, promotions: Promotion[]) {
        for (const line of order.lines) {
            // Must be re-calculated for each line, since the previous lines may have triggered promotions
            // which affected the order price.
            const applicablePromotions = await filterAsync(promotions, p =>
                p.test(order, this.promotionUtils),
            );

            line.clearAdjustments(AdjustmentType.PROMOTION);

            for (const promotion of applicablePromotions) {
                if (await promotion.test(order, this.promotionUtils)) {
                    for (const item of line.items) {
                        if (applicablePromotions) {
                            const adjustment = promotion.apply(item, line);
                            if (adjustment) {
                                item.pendingAdjustments = item.pendingAdjustments.concat(adjustment);
                            }
                        }
                    }
                }
                this.calculateOrderTotals(order);
            }
        }

        const applicableOrderPromotions = await filterAsync(promotions, p =>
            p.test(order, this.promotionUtils),
        );
        if (applicableOrderPromotions.length) {
            for (const promotion of applicableOrderPromotions) {
                // re-test the promotion on each iteration, since the order total
                // may be modified by a previously-applied promotion
                if (await promotion.test(order, this.promotionUtils)) {
                    const adjustment = promotion.apply(order);
                    if (adjustment) {
                        order.pendingAdjustments = order.pendingAdjustments.concat(adjustment);
                    }
                }
            }
            this.calculateOrderTotals(order);
        }
    }

    private async applyShipping(ctx: RequestContext, order: Order) {
        const results = await this.shippingCalculator.getEligibleShippingMethods(ctx, order);
        const currentShippingMethod = order.shippingMethod;
        if (results && results.length && currentShippingMethod) {
            let selected: { method: ShippingMethod; price: number } | undefined;
            selected = results.find(r => idsAreEqual(r.method.id, currentShippingMethod.id));
            if (!selected) {
                selected = results[0];
            }
            order.shipping = selected.price;
        }
    }

    private calculateOrderTotals(order: Order) {
        let totalPrice = 0;
        let totalTax = 0;

        for (const line of order.lines) {
            totalPrice += line.totalPrice;
            totalTax += line.lineTax;
        }
        const totalPriceBeforeTax = totalPrice - totalTax;

        order.subTotalBeforeTax = totalPriceBeforeTax;
        order.subTotal = totalPrice;
    }
}
