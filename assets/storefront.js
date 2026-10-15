/* WooCommerce variation events; HTML comes only from escaped server date formatter. */
(function ($) {
 'use strict';
 $(function () {
  $('form.variations_form').each(function () {
   var form=$(this),root=form.closest('.product'),slot=root.find('.sdd-sale-date-slot').first();
   if(!slot.length)return;
   var initial=slot.html();
   form.on('found_variation.sdd',function(event,variation){slot.html(variation.sdd_sale_end_html||'');});
   form.on('reset_data.sdd hide_variation.sdd',function(){slot.html(initial);});
  });
 });
})(jQuery);
