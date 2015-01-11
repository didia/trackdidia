#!/usr/bin/env python
# -*- coding: utf-8 -*-
'''
Created on 2014-10-31

@author: didia
'''

from google.appengine.api import mail

def compute_execution_stats_for_week(week):
    days = week.get_all_days()
    stats = [compute_execution_stats_for_day(day) for day in days]
    stat = {}
    result = week.get_stat()[0]
    total = week.get_stat()[1]
    
    stat['id'] = week.key.id()
    stat['total'] = total
    stat['result'] = result
    stat['percent'] = int(round((float(result) * 100)/total))
    stat['days'] = stats
    return stat;


def compute_execution_stats_for_day(day):
    stat = {}
    result = day.get_stat()[0]
    total = day.get_stat()[1]
    percent = int(round((float(result) * 100)/total))
    stat['percent'] = percent
    stat['result'] = result
    stat['total'] = total
    stat['id'] = day.key.id()
    
    return stat;

def compute_stress_stats_for_week(week):
    days = week.get_all_days()
    stats = [compute_stress_stats_for_day(day) for day in days]
    stat = {}
    result  = week.get_stress()
    total = 24*7
    stat['id'] = week.key.id()
    stat['total'] = total
    stat['result'] = result
    stat['percent'] = int(round((float(result) * 100)/total))
    stat['days'] = stats
    stat['id'] = day.key.id()
    
    return stat

def compute_stress_stats_for_day(day):
    stat = {}
    result = day.get_stress()
    total = 24
    percent = int(round((float(result)*100)/total))
    stat['percent'] = percent
    stat['result'] = result
    stat['total'] = total
    stat['id'] = day.key.id()
    
    return stat;

def compare_week_stats(compared_to_week, target_week):
    target_week['variation'] = target_week['percent'] - compared_to_week['percent'] if compared_to_week else 0;
    if not compared_to_week:
        return
    days = target_week['days']
    c_days = compared_to_week['days']
    for i in range(len(days)):
        days[i]['variation'] = days[i]['percent'] - c_days[i]['percent']
    
    
def send_stat(user, schedule):
    stat = compute_execution_stats_for_week(schedule)
    message = {}
    
    message["body"] = get_plain_message(stat)
    message["html"] = get_html_message(stat)
    
    send_mail(user, message)
    
    return message["body"]

def get_stat(schedule):
    stat = compute_execution_stats_for_week(schedule)
    return stat

def get_html_message(stat):
    message = "<html><body><p> Here is your result for the last week : <b>"
    message += str(stat['result']) + " points sur" + str(stat['total']) + " possible </b></p>"
    message += "<table><tr><th> Day id </th><th> Result </th> </tr>"
    
    for i in range(7):
        message += "<tr><td> Day " + str(i + 1) + "</td><td><b> "
        message += str(stat["days"][i]["result"]) + " points sur " + str(stat["days"][i]["total"]) + " possible </b>"
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
        by_day_message += "Day " + str(i + 1) + " : " 
        by_day_message += str(stat["days"][i]["result"]) + " points  sur " + str(stat["days"][i]["total"])
        by_day_message += " possible \n"
    
    message = message.format(stat["result"], stat["total"], by_day_message)
    return message
    
def send_mail(user, message):
    to_format = "{} <{}>"
    email = mail.EmailMessage(sender="Trackdidia Support <thefuture2092@gmail.com>",
                             subject="Your weekly stat")

    email.to = to_format.format(user.nickname, user.email)
    email.body = message["body"] 
    email.html = message["html"]
    email.send()


    
