#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-31

@author: didia
'''

from google.appengine.ext import ndb
from google.appengine.api import mail

def compute_stats_for_schedule(schedule):
    days = schedule.get_all_days();
    total = 0
    result = 0
    stats = [compute_stats_for_day(day, schedule.interval) for day in days]
    for stat in stats:
        total += stat['total']
        result += stat['result']
    stat = {}
    stat['total'] = total
    stat['result'] = result
    stat['days'] = stats
    return stat;
    
def compute_stats_for_day(day, interval):
    stat = {}
    total = 0
    result = 0
    for slot in day.get_slots():
        points = slot.duration * interval
        total += points
        if slot.executed:
            result += points
    
    stat['result'] = result
    stat['total'] = total;
    return stat

def send_stat(user, schedule):
    stat = compute_stats_for_schedule(schedule)
    message = {}
    
    message["body"] = get_plain_message(stat)
    message["html"] = get_html_message(stat)
    
    send_mail(user, message)
    
    return message["body"]

def get_stat(schedule):
    stat = compute_stats_for_schedule(schedule)
    return stat

def get_html_message(stat):
    message = "<html><body><p> Here is your result for the last week : <b>"
    message += str(stat['result']) + " points sur" + str(stat['total']) + " possible </b></p>"
    message += "<table><tr><th> Day id </th><th> Result </th> </tr>"
    
    for i in range(7):
        message += "<tr><td> Day " + str(i+1) + "</td><td><b> "
        message +=  str(stat["days"][i]["result"]) + " points sur " + str(stat["days"][i]["total"]) + " possible </b>"
        message += "</td></tr>"
    message += "</table></body></html>"
    return message


def get_plain_message(stat):
    message = """ Here is your result for the last week : {} points sur {} possible 
    Here is the breakdown by day : 
    {}
    """
    by_day_message = ""
    for i in range(7):
        by_day_message += "Day " + str(i+1) + " : " 
        by_day_message += str(stat["days"][i]["result"]) + " points  sur " + str(stat["days"][i]["total"])
        by_day_message += " possible \n"
    
    message.format(stat["result"], stat["total"], by_day_message)
    return message
    
def send_mail(user, message):
    to_format = "{} <{}>"
    email = mail.EmailMessage(sender="Trackdidia Support <thefuture2092@gmail.com>",
                             subject="Your weekly stat")

    email.to = to_format.format(user.nickname, user.email)
    email.body = message["body"] 
    email.html = message["html"]
    email.send()

    
    