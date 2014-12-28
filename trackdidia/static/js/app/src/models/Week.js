/**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["models/Day"], function(Day){
   
   function Week(weekData) {
        this.id = weekData.id;
        this.starting_date = weekData.starting_date;
        this.ending_date = weekData.ending_date;
        this.stat = weekData.stat;
        this.days = this.initDays(weekData.days);
        this.links = weekData.links;
   };

   Week.prototype = {
       construtor : Week,

       initDays: function(daysData) {
       		var days = {}
       		daysData.forEach(function(dayData) {
       			var day = new Day(dayData);
       			days[day.id] = day;
       		});
       		return days;
       }

   }
   return Week;

 })